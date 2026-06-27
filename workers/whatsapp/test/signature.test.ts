import { describe, expect, test } from "bun:test";
import { computeSignatureHex, verifySignatureWithSecret } from "../src/whatsapp/signature.ts";

const SECRET = "test-app-secret";
const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

describe("signature verification", () => {
  test("accepts a correctly signed body", () => {
    const header = `sha256=${computeSignatureHex(BODY, SECRET)}`;
    expect(verifySignatureWithSecret(BODY, header, SECRET)).toBe(true);
  });

  test("is case-insensitive on the hex digest", () => {
    const header = `sha256=${computeSignatureHex(BODY, SECRET).toUpperCase()}`;
    expect(verifySignatureWithSecret(BODY, header, SECRET)).toBe(true);
  });

  test("rejects a tampered body", () => {
    const header = `sha256=${computeSignatureHex(BODY, SECRET)}`;
    expect(verifySignatureWithSecret(`${BODY} `, header, SECRET)).toBe(false);
  });

  test("rejects the wrong secret", () => {
    const header = `sha256=${computeSignatureHex(BODY, SECRET)}`;
    expect(verifySignatureWithSecret(BODY, header, "other-secret")).toBe(false);
  });

  test("rejects a missing header", () => {
    expect(verifySignatureWithSecret(BODY, undefined, SECRET)).toBe(false);
    expect(verifySignatureWithSecret(BODY, null, SECRET)).toBe(false);
  });

  test("rejects a header without the sha256= prefix", () => {
    expect(verifySignatureWithSecret(BODY, computeSignatureHex(BODY, SECRET), SECRET)).toBe(false);
  });

  test("rejects non-hex, odd-length, and wrong-length signatures", () => {
    expect(verifySignatureWithSecret(BODY, "sha256=zzzz", SECRET)).toBe(false);
    expect(verifySignatureWithSecret(BODY, "sha256=abc", SECRET)).toBe(false);
    expect(verifySignatureWithSecret(BODY, "sha256=abcd", SECRET)).toBe(false);
  });

  test("rejects an empty secret", () => {
    const header = `sha256=${computeSignatureHex(BODY, SECRET)}`;
    expect(verifySignatureWithSecret(BODY, header, "")).toBe(false);
  });
});
