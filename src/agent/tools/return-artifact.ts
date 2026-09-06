import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  detectReturnedArtifactContentType,
  MAX_RETURNED_ARTIFACT_BYTES,
  returnedArtifactMediaType,
  type ReturnedArtifactContentType,
  type ReturnedArtifactGenerator,
} from "../../returned-artifacts.js";
import type { MediaAttachment } from "../../types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";

export const RESIDENT_RETURNED_ARTIFACT_DIRECTORY = "returned-artifacts";
const MAX_CAPTION_BYTES = 2_048;

const EXTENSIONS: Readonly<Record<ReturnedArtifactContentType, string>> = Object.freeze({
  "application/pdf": ".pdf",
  "audio/mpeg": ".mp3",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "text/plain": ".txt",
});

function safeName(value: string): string {
  const name = value.normalize("NFC");
  if (
    name.length < 1 || name.length > 255 || name !== value || name === "." || name === ".." ||
    /^[A-Za-z]:/u.test(name) || /[\0-\x1f\x7f/\\]/u.test(name)
  ) throw new Error("returned artifact name is invalid");
  return name;
}

function ensureChild(parent: string, name: string): string {
  const child = join(parent, name);
  try {
    mkdirSync(child, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = lstatSync(child);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(child) !== child) {
    throw new Error("resident media output directory is invalid");
  }
  chmodSync(child, 0o700);
  return child;
}

export function canonicalReturnedArtifactDirectory(workspacePath: string): string {
  const workspace = resolve(workspacePath);
  const entry = lstatSync(workspace);
  const canonical = realpathSync(workspace);
  const allowedMacAlias = workspace.startsWith("/var/") && canonical === `/private${workspace}`;
  if (!entry.isDirectory() || entry.isSymbolicLink() || (canonical !== workspace && !allowedMacAlias)) {
    throw new Error("resident workspace is invalid");
  }
  return ensureChild(ensureChild(canonical, "media"), RESIDENT_RETURNED_ARTIFACT_DIRECTORY);
}

function exactCaption(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_CAPTION_BYTES) {
    throw new Error("returned artifact caption is invalid");
  }
  return value;
}

function descriptor(input: {
  path: string;
  fileName: string;
  bytes: Buffer;
  contentType: ReturnedArtifactContentType;
  generatedBy: ReturnedArtifactGenerator;
  caption?: string;
}): MediaAttachment {
  return Object.freeze({
    type: returnedArtifactMediaType(input.contentType, input.generatedBy),
    path: input.path,
    generatedBy: input.generatedBy,
    mimeType: input.contentType,
    fileName: input.fileName,
    byteCount: input.bytes.length,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    ...(input.caption === undefined ? {} : { caption: exactCaption(input.caption) }),
  });
}

export function writeReturnedArtifactBytes(input: {
  workspacePath: string;
  bytes: Buffer;
  stem: string;
  generatedBy: ReturnedArtifactGenerator;
  caption?: string;
}): MediaAttachment {
  const contentType = detectReturnedArtifactContentType(input.bytes);
  const caption = exactCaption(input.caption);
  const root = canonicalReturnedArtifactDirectory(input.workspacePath);
  const stem = input.stem.normalize("NFC").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "artifact";
  const fileName = safeName(
    `${stem}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(6).toString("hex")}${EXTENSIONS[contentType]}`,
  );
  const path = join(root, fileName);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const directoryFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  const before = fstatSync(directoryFd);
  let fileFd: number | undefined;
  let complete = false;
  try {
    fileFd = openSync(path, flags, 0o600);
    writeFileSync(fileFd, input.bytes);
    fsyncSync(fileFd);
    const written = fstatSync(fileFd);
    if (!written.isFile() || written.size !== input.bytes.length) throw new Error("returned artifact write failed");
    const after = lstatSync(root);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || realpathSync(root) !== root) {
      throw new Error("resident media output directory changed");
    }
    fsyncSync(directoryFd);
    const artifact = descriptor({
      path,
      fileName,
      bytes: input.bytes,
      contentType,
      generatedBy: input.generatedBy,
      caption,
    });
    complete = true;
    return artifact;
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (!complete) {
      try { if (fileFd !== undefined) unlinkSync(path); } catch { /* best-effort rollback of our exclusive file */ }
    }
    closeSync(directoryFd);
  }
}

function inspectWorkspaceArtifact(pathValue: unknown, ctx: ToolContext): MediaAttachment {
  if (typeof pathValue !== "string" || pathValue.length < 1 || pathValue.length > 4_096 || pathValue.includes("\0")) {
    throw new Error("artifact path is invalid");
  }
  const root = canonicalReturnedArtifactDirectory(ctx.workspacePath);
  const declared = isAbsolute(pathValue) ? resolve(pathValue) : resolve(ctx.workspacePath, pathValue);
  const entry = lstatSync(declared);
  const canonical = realpathSync(declared);
  if (!entry.isFile() || entry.isSymbolicLink() || dirname(canonical) !== root || canonical !== join(root, basename(canonical))) {
    throw new Error("artifact must be a real file in the private media output directory");
  }
  const fd = openSync(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino || before.size < 1 || before.size > MAX_RETURNED_ARTIFACT_BYTES) {
      throw new Error("artifact file is invalid");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(canonical);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== after.size || pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
      throw new Error("artifact changed while being inspected");
    }
    fchmodSync(fd, 0o600);
    return descriptor({
      path: canonical,
      fileName: safeName(basename(canonical)),
      bytes,
      contentType: detectReturnedArtifactContentType(bytes),
      generatedBy: "return_artifact",
    });
  } finally {
    closeSync(fd);
  }
}

function summary(media: MediaAttachment): string {
  return `Ready to return ${JSON.stringify(media.fileName)} (${media.mimeType}, ${media.byteCount} bytes, sha256 ${media.sha256}).`;
}

export const returnArtifactTool: ToolDefinition = {
  name: "return_artifact",
  description: "Attach one existing, non-empty PDF, UTF-8 text file, PNG/JPEG/GIF image, or MP3 located directly inside the private workspace media/returned-artifacts directory.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path or workspace-relative path to a real file directly inside media/returned-artifacts.",
      },
    },
    required: ["path"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const media = inspectWorkspaceArtifact(input.path, ctx);
      return { content: summary(media), media: [media] };
    } catch {
      return {
        content: "Artifact return refused: provide a real, non-empty supported file directly inside the private media/returned-artifacts directory.",
        is_error: true,
      };
    }
  },
};

export const returnTextArtifactTool: ToolDefinition = {
  name: "return_text_artifact",
  description: "Create and attach one new plain-text artifact. Markdown formatting is supported.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short label or stem used for the generated filename.",
      },
      content: {
        type: "string",
        description: "Complete UTF-8 contents of the returned text artifact.",
      },
      caption: {
        type: "string",
        description: "Optional short human-readable caption.",
      },
    },
    required: ["name", "content"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof input.name !== "string" || typeof input.content !== "string") {
        throw new Error("returned text artifact input is invalid");
      }
      const name = safeName(input.name);
      const stem = name.replace(/\.(?:md|txt)$/iu, "");
      const media = writeReturnedArtifactBytes({
        workspacePath: ctx.workspacePath,
        bytes: Buffer.from(input.content, "utf8"),
        stem,
        generatedBy: "return_artifact",
        ...(input.caption === undefined ? {} : { caption: input.caption as string }),
      });
      return returnedArtifactResult(media, "Text artifact created");
    } catch {
      return {
        content: "Text artifact return refused: provide a non-empty UTF-8 text or Markdown document with a simple filename.",
        is_error: true,
      };
    }
  },
};

export function returnedArtifactResult(media: MediaAttachment, prefix: string): ToolResult {
  return { content: `${prefix}. ${summary(media)}`, media: [media] };
}
