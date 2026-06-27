/**
 * X-Hub-Signature-256 verification.
 *
 * Every inbound webhook POST is verified before its body is parsed or trusted, so only genuine
 * Meta traffic can inject documents into the pipeline. We compute HMAC-SHA256 over the EXACT raw
 * request bytes under the app secret and compare it, in constant time, against the hex value after
 * the `sha256=` prefix. Any tampering, wrong secret, missing/malformed header, or wrong digest
 * length returns false. The unset-secret case (verification disabled) is the caller's decision.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const DIGEST_BYTE_LENGTH = 32;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

function toBuffer(rawBody: string | Uint8Array): Buffer {
  return typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
}

/** Lowercase hex HMAC-SHA256 of `rawBody` under `secret`. Used by the verifier and the simulator. */
export function computeSignatureHex(rawBody: string | Uint8Array, secret: string): string {
  return createHmac("sha256", secret).update(toBuffer(rawBody)).digest("hex");
}

/**
 * Verify the header against the raw body under an explicit secret. Pure - no env access. Returns
 * true only when the header is `sha256=` followed by the correct 32-byte HMAC of exactly these
 * bytes. Every rejection path returns false so the caller can respond 403 and mutate nothing.
 */
export function verifySignatureWithSecret(
  rawBody: string | Uint8Array,
  header: string | undefined | null,
  secret: string,
): boolean {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (header === undefined || header === null) return false;

  const trimmed = header.trim();
  if (!trimmed.startsWith(SIGNATURE_PREFIX)) return false;

  const provided = trimmed.slice(SIGNATURE_PREFIX.length);
  if (provided.length === 0 || provided.length % 2 !== 0 || !HEX_PATTERN.test(provided)) {
    return false;
  }

  const providedDigest = Buffer.from(provided, "hex");
  if (providedDigest.length !== DIGEST_BYTE_LENGTH) return false;

  const expectedDigest = createHmac("sha256", secret).update(toBuffer(rawBody)).digest();
  // Decoding hex to bytes makes this comparison inherently case-insensitive.
  return timingSafeEqual(providedDigest, expectedDigest);
}
