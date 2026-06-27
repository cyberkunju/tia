/**
 * Local on-disk bytes store. Downloaded media is written under the staging directory, keyed by
 * content hash so identical bytes map to one file. The TIA pipeline reads `bytes_uri` from there.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BytesStore {
  /** Write `buffer` for `contentHash` and return its absolute path (the `bytes_uri`). */
  write(contentHash: string, mime: string | undefined, buffer: Buffer): Promise<string>;
}

const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/tiff": "tiff",
};

export function extForMime(mime: string | undefined): string {
  if (mime === undefined) return "bin";
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MIME_EXT[base] ?? "bin";
}

export function createDiskBytesStore(stagingDir: string): BytesStore {
  const dir = resolve(stagingDir);
  mkdirSync(dir, { recursive: true });
  return {
    async write(contentHash, mime, buffer) {
      const path = join(dir, `${contentHash}.${extForMime(mime)}`);
      await Bun.write(path, buffer);
      return path;
    },
  };
}
