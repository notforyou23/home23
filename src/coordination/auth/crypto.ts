import {
  createHmac,
  hkdfSync,
  randomBytes as secureRandomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

const AUTH_KEY_DOMAIN = Buffer.from("home23.coordination.auth.v1", "utf8");
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;
const REFRESH_TOKEN_PATTERN = /^h23r1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

export type AuthRandomBytes = (size: number) => Uint8Array;

function randomBuffer(randomBytes: AuthRandomBytes, size: number): Buffer {
  const bytes = Buffer.from(randomBytes(size));
  if (bytes.length !== size) {
    throw new Error(`auth randomness source returned ${bytes.length} bytes; expected ${size}`);
  }
  return bytes;
}

function scryptDigest(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      32,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELISM,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });
}

export function deriveAuthKey(keyMaterial: Uint8Array, purpose: string): Buffer {
  const material = Buffer.from(keyMaterial);
  if (material.length < 32 || material.length > 1024) {
    throw new Error("auth key material must contain 32 to 1024 bytes");
  }
  try {
    return Buffer.from(
      hkdfSync("sha256", material, AUTH_KEY_DOMAIN, Buffer.from(purpose, "utf8"), 32),
    );
  } finally {
    material.fill(0);
  }
}

export function generatePairingCode(
  randomBytes: AuthRandomBytes = secureRandomBytes,
): string {
  let canonical = "";
  while (canonical.length < 10) {
    const byte = randomBuffer(randomBytes, 1)[0] as number;
    if (byte >= 224) continue;
    canonical += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  }
  return `${canonical.slice(0, 5)}-${canonical.slice(5)}`;
}

function normalizePairingCode(value: string): string | null {
  if (typeof value !== "string" || value.length < 10 || value.length > 11) return null;
  const match = /^([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5})(?:[- ]?)([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5})$/i.exec(value);
  const canonical = match ? `${match[1]}${match[2]}`.toUpperCase() : "";
  return PAIRING_CODE_PATTERN.test(canonical) ? canonical : null;
}

export async function createPairingCodeVerifier(
  pairingCode: string,
  randomBytes: AuthRandomBytes = secureRandomBytes,
): Promise<string> {
  const canonical = normalizePairingCode(pairingCode);
  if (!canonical) throw new Error("generated pairing code is invalid");
  const salt = randomBuffer(randomBytes, 16);
  const digest = await scryptDigest(canonical, salt);
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISM,
    salt.toString("base64url"),
    digest.toString("base64url"),
  ].join("$");
}

export async function verifyPairingCode(
  pairingCode: string,
  verifier: string,
): Promise<boolean> {
  const canonical = normalizePairingCode(pairingCode);
  if (typeof verifier !== "string" || Buffer.byteLength(verifier, "utf8") !== 83) {
    return false;
  }
  const parts = verifier.split("$");
  if (
    !canonical ||
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    parts[1] !== String(SCRYPT_COST) ||
    parts[2] !== String(SCRYPT_BLOCK_SIZE) ||
    parts[3] !== String(SCRYPT_PARALLELISM)
  ) {
    return false;
  }
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length !== 16 || expected.length !== 32) return false;
  const actual = await scryptDigest(canonical, salt);
  return timingSafeEqual(actual, expected);
}

export interface RefreshCredential {
  raw: string;
  id: string;
  digest: string;
}

function keyedBytes(key: Uint8Array, purpose: string, context: string): Buffer {
  return createHmac("sha256", key)
    .update(`home23.${purpose}.v1`, "utf8")
    .update(Buffer.from([0]))
    .update(context, "utf8")
    .digest();
}

/** Reconstructs a 50-bit pairing code for idempotent one-use delivery. */
export function derivePairingCode(key: Uint8Array, context: string): string {
  const bytes = keyedBytes(key, "pairing-code", context);
  let canonical = "";
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[index] as number;
    canonical += PAIRING_ALPHABET[byte & 31];
  }
  return `${canonical.slice(0, 5)}-${canonical.slice(5)}`;
}

/** Reconstructs a 256-bit refresh secret without persisting the raw token. */
export function deriveRefreshCredential(
  refreshDigestKey: Uint8Array,
  generationKey: Uint8Array,
  context: string,
): RefreshCredential {
  const id = keyedBytes(generationKey, "refresh-id", context)
    .subarray(0, 16)
    .toString("base64url");
  const secret = keyedBytes(generationKey, "refresh-secret", context)
    .toString("base64url");
  const raw = `h23r1.${id}.${secret}`;
  return { raw, id, digest: digestRefreshToken(raw, refreshDigestKey) };
}

export function deriveOpaqueId(key: Uint8Array, purpose: string, context: string): string {
  return keyedBytes(key, purpose, context).subarray(0, 16).toString("base64url");
}

export function digestMutationRequest(
  key: Uint8Array,
  operation: string,
  canonicalRequest: string,
): string {
  return keyedBytes(key, `idempotency-request.${operation}`, canonicalRequest)
    .toString("hex");
}

export function createRefreshCredential(
  refreshDigestKey: Uint8Array,
  randomBytes: AuthRandomBytes = secureRandomBytes,
): RefreshCredential {
  const id = randomBuffer(randomBytes, 16).toString("base64url");
  const secret = randomBuffer(randomBytes, 32).toString("base64url");
  const raw = `h23r1.${id}.${secret}`;
  return { raw, id, digest: digestRefreshToken(raw, refreshDigestKey) };
}

export function parseRefreshToken(value: string): { id: string } | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256) return null;
  const match = REFRESH_TOKEN_PATTERN.exec(value);
  return match?.[1] ? { id: match[1] } : null;
}

export function digestRefreshToken(value: string, refreshDigestKey: Uint8Array): string {
  return createHmac("sha256", refreshDigestKey)
    .update("home23.refresh-token.v1", "utf8")
    .update(Buffer.from([0]))
    .update(value, "utf8")
    .digest("hex");
}

export function createOpaqueFamilyId(
  randomBytes: AuthRandomBytes = secureRandomBytes,
): string {
  return randomBuffer(randomBytes, 16).toString("base64url");
}
