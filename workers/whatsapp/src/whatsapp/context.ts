/**
 * Per-message outbound routing context (multi-number support).
 *
 * TIA may be connected to more than one WhatsApp business number under one Meta app (e.g. a test
 * number and a live number). A reply must be sent FROM the same number the inbound message arrived
 * on, because WhatsApp's 24-hour customer-service window is scoped per business number. Rather than
 * thread a "from" id through every send call site, the inbound pipeline wraps per-message work in
 * {@link withSendFrom} and the Sender reads {@link currentSendFrom} when it builds the URL. Async
 * hops preserve the store, so every send for that message originates from the right number with no
 * change to call sites. With no active context (e.g. a proactive send), the Sender uses its default.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface SendContext {
  readonly fromPhoneNumberId?: string | undefined;
}

const storage = new AsyncLocalStorage<SendContext>();

export function withSendFrom<T>(fromPhoneNumberId: string | undefined, fn: () => T): T {
  return storage.run({ fromPhoneNumberId }, fn);
}

export function currentSendFrom(): string | undefined {
  const id = storage.getStore()?.fromPhoneNumberId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
