/**
 * Media service - two-hop inbound download from the Meta Graph API.
 *
 *   hop 1: GET {graphBaseUrl}/{mediaId}            → { url, mime_type, file_size }
 *   hop 2: GET {url}  (with the Bearer token)      → the binary bytes
 *
 * Each hop is bounded by an 8s timeout. ANY failure (timeout, missing url, API error, oversized
 * file) makes the whole download FAIL SAFE: it returns null and records an audit entry, and the
 * caller skips that message. The fetch port is injectable so the failure matrix is testable with
 * no network.
 */
import { graphBaseUrl, type AppConfig } from "../config.ts";

export const MEDIA_TIMEOUT_MS = 8_000;

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers: { get(name: string): string | null };
}>;

export type MediaAuditStage =
  | "download_metadata"
  | "download_missing_url"
  | "download_too_large"
  | "download_binary";

export interface MediaAuditEntry {
  readonly stage: MediaAuditStage;
  readonly mediaId?: string | undefined;
  readonly reason: string;
}

export interface DownloadedMedia {
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface MediaServiceDeps {
  readonly graphBaseUrl: string;
  readonly token: string;
  readonly maxBytes: number;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly onAudit?: (entry: MediaAuditEntry) => void | Promise<void>;
}

export interface MediaService {
  downloadMedia(mediaId: string): Promise<DownloadedMedia | null>;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): ReturnType<FetchLike> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError" ? "timeout" : error.name;
  }
  return "unknown error";
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function createMediaService(deps: MediaServiceDeps): MediaService {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = deps.timeoutMs ?? MEDIA_TIMEOUT_MS;
  const onAudit = deps.onAudit ?? (() => {});
  const authHeader = `Bearer ${deps.token}`;

  async function audit(entry: MediaAuditEntry): Promise<void> {
    try {
      await onAudit(entry);
    } catch {
      /* auditing must never break the fail-safe path */
    }
  }

  async function downloadMedia(mediaId: string): Promise<DownloadedMedia | null> {
    if (typeof mediaId !== "string" || mediaId.length === 0) {
      await audit({ stage: "download_metadata", reason: "absent media id" });
      return null;
    }

    // Hop 1 - metadata.
    let metaUrl: string;
    let metaMime: string | undefined;
    let declaredSize: number | undefined;
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        `${deps.graphBaseUrl}/${encodeURIComponent(mediaId)}`,
        { method: "GET", headers: { Authorization: authHeader } },
        timeoutMs,
      );
      if (!res.ok) {
        await audit({
          stage: "download_metadata",
          mediaId,
          reason: `metadata request returned status ${res.status}`,
        });
        return null;
      }
      const meta = (await res.json()) as
        | { url?: unknown; mime_type?: unknown; file_size?: unknown }
        | null;
      const url = meta?.url;
      if (typeof url !== "string" || url.length === 0) {
        await audit({
          stage: "download_missing_url",
          mediaId,
          reason: "metadata response had no download url",
        });
        return null;
      }
      metaUrl = url;
      metaMime = typeof meta?.mime_type === "string" ? meta.mime_type : undefined;
      declaredSize = typeof meta?.file_size === "number" ? meta.file_size : undefined;
    } catch (error) {
      await audit({
        stage: "download_metadata",
        mediaId,
        reason: `metadata request failed: ${describeError(error)}`,
      });
      return null;
    }

    // Reject oversized files before pulling the bytes, when Meta declared a size.
    if (declaredSize !== undefined && declaredSize > deps.maxBytes) {
      await audit({
        stage: "download_too_large",
        mediaId,
        reason: `declared file_size ${declaredSize} exceeds limit ${deps.maxBytes}`,
      });
      return null;
    }

    // Hop 2 - binary.
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        metaUrl,
        { method: "GET", headers: { Authorization: authHeader } },
        timeoutMs,
      );
      if (!res.ok) {
        await audit({
          stage: "download_binary",
          mediaId,
          reason: `binary fetch returned status ${res.status}`,
        });
        return null;
      }
      const bytes = await res.arrayBuffer();
      const buffer = Buffer.from(bytes);
      if (buffer.length > deps.maxBytes) {
        await audit({
          stage: "download_too_large",
          mediaId,
          reason: `downloaded ${buffer.length} bytes exceeds limit ${deps.maxBytes}`,
        });
        return null;
      }
      const headerMime = res.headers.get("content-type") ?? undefined;
      const mimeType = firstNonEmpty(metaMime, headerMime) ?? "application/octet-stream";
      return { buffer, mimeType, byteSize: buffer.length };
    } catch (error) {
      await audit({
        stage: "download_binary",
        mediaId,
        reason: `binary fetch failed: ${describeError(error)}`,
      });
      return null;
    }
  }

  return { downloadMedia };
}

export function createMediaServiceFromConfig(
  cfg: AppConfig,
  overrides: Partial<Pick<MediaServiceDeps, "fetch" | "timeoutMs" | "onAudit">> = {},
): MediaService {
  return createMediaService({
    graphBaseUrl: graphBaseUrl(cfg),
    token: cfg.meta.token,
    maxBytes: cfg.ingest.maxMediaBytes,
    fetch: overrides.fetch,
    timeoutMs: overrides.timeoutMs,
    onAudit: overrides.onAudit,
  });
}
