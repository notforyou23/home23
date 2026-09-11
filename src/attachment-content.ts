/** File transport is independent of whether a model or a viewer can decode it. */
export const ATTACHMENT_PREVIEW_CONTENT_TYPES = Object.freeze([
  "application/octet-stream", "application/pdf", "audio/mpeg",
  "image/gif", "image/jpeg", "image/png", "image/webp", "image/heic", "image/avif",
  "text/plain",
] as const);

export function isAttachmentContentType(value: string): boolean {
  return value.length <= 255 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value);
}

/** Deterministic across filenames/declarations so equal digests have equal metadata.
 * Only inspect signatures, never decompress images, archives or documents here.
 * Active markup and unrecognized formats use an opaque download disposition.
 */
export function detectAttachmentContentType(
  prefix: Buffer, validUtf8Text: boolean, containsNul: boolean,
): string {
  if (prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a$/.test(prefix.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (prefix.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = prefix.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "image/heic";
    if (["avif", "avis"].includes(brand)) return "image/avif";
  }
  if (prefix.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (prefix.subarray(0, 3).toString("ascii") === "ID3" || (prefix.length >= 4 && prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0 && ((prefix[1]! >> 3) & 3) !== 1 && ((prefix[1]! >> 1) & 3) !== 0 && (prefix[2]! >> 4) > 0 && (prefix[2]! >> 4) < 15 && ((prefix[2]! >> 2) & 3) !== 3)) return "audio/mpeg";
  if (validUtf8Text && !containsNul) {
    const leading = prefix.toString("utf8").replace(/^\uFEFF/u, "").trimStart();
    if (!/^(?:<!doctype\s+html|<html\b|<script\b|<svg\b|<\?xml\b)/iu.test(leading)) return "text/plain";
  }
  return "application/octet-stream";
}

export function attachmentContentType(bytes: Buffer): string {
  let validUtf8 = true;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { validUtf8 = false; }
  return detectAttachmentContentType(bytes.subarray(0, 4096), validUtf8, bytes.includes(0));
}
