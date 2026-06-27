import { describe, expect, test } from "bun:test";
import {
  createDedupStore,
  createFakeDurableDedupStore,
  type DurableDedupStore,
} from "../src/whatsapp/dedup.ts";

describe("two-layer dedup", () => {
  test("first claim wins, second is a duplicate (in-memory ring after markProcessed)", async () => {
    const dedup = createDedupStore({ durable: createFakeDurableDedupStore() });
    expect(await dedup.claim("wamid.1")).toBe("claimed");
    await dedup.markProcessed("wamid.1");
    expect(await dedup.claim("wamid.1")).toBe("duplicate");
  });

  test("concurrent claims for one fresh id yield exactly one 'claimed'", async () => {
    const dedup = createDedupStore({ durable: createFakeDurableDedupStore() });
    const results = await Promise.all(Array.from({ length: 10 }, () => dedup.claim("wamid.race")));
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
  });

  test("an absent id is always claimable (cannot be deduped)", async () => {
    const dedup = createDedupStore({ durable: createFakeDurableDedupStore() });
    expect(await dedup.claim(undefined)).toBe("claimed");
    expect(await dedup.claim("")).toBe("claimed");
  });

  test("expired in-progress reservation is re-claimable", async () => {
    let nowMs = 1_000_000;
    const dedup = createDedupStore({
      durable: createFakeDurableDedupStore(),
      now: () => nowMs,
      inProgressTtlMs: 60_000,
    });
    expect(await dedup.claim("wamid.crash")).toBe("claimed"); // reserved, never completed
    expect(await dedup.claim("wamid.crash")).toBe("duplicate"); // still live
    nowMs += 60_001; // reservation ages out
    expect(await dedup.claim("wamid.crash")).toBe("claimed"); // reclaimed
  });

  test("releaseClaim lets a retry reprocess", async () => {
    const dedup = createDedupStore({ durable: createFakeDurableDedupStore() });
    expect(await dedup.claim("wamid.rel")).toBe("claimed");
    await dedup.releaseClaim("wamid.rel");
    expect(await dedup.claim("wamid.rel")).toBe("claimed");
  });

  test("fails open when the durable layer throws", async () => {
    const throwing: DurableDedupStore = {
      claim: () => Promise.reject(new Error("db down")),
      markProcessed: async () => {},
      release: async () => {},
      prune: async () => 0,
    };
    const dedup = createDedupStore({ durable: throwing });
    expect(await dedup.claim("wamid.failopen")).toBe("claimed");
  });

  test("fails open when the durable layer times out", async () => {
    const hanging: DurableDedupStore = {
      claim: () => new Promise(() => {}), // never resolves
      markProcessed: async () => {},
      release: async () => {},
      prune: async () => 0,
    };
    const dedup = createDedupStore({ durable: hanging, durableTimeoutMs: 20 });
    expect(await dedup.claim("wamid.timeout")).toBe("claimed");
  });

  test("prune removes only retained-past processed rows", async () => {
    let nowMs = 10_000_000;
    const fake = createFakeDurableDedupStore();
    const dedup = createDedupStore({
      durable: fake,
      now: () => nowMs,
      retentionMs: 1000,
    });
    fake.seed("old", "processed", nowMs - 5000);
    fake.seed("fresh", "processed", nowMs - 100);
    expect(await dedup.prune()).toBe(1);
    expect(fake.peek("old")).toBeUndefined();
    expect(fake.peek("fresh")).toBeDefined();
  });
});
