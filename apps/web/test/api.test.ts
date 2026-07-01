import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, API_BASE } from "../src/api";

/**
 * api.ts is the single network seam of the SPA. Every method is exercised here
 * against a stubbed global fetch so we assert: URL construction, HTTP method,
 * request body shape, idempotency/auth headers, JSON-vs-text parsing, error
 * propagation, and the SSE stream decoder. No real network is ever touched.
 */

type FetchInit = RequestInit | undefined;

interface FakeResOpts {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  textThrows?: boolean;
}

/** Build a minimal Response-like object matching what `req` reads. */
function fakeRes(body: unknown, opts: FakeResOpts = {}) {
  const {
    ok = true,
    status = 200,
    statusText = "OK",
    contentType = "application/json",
    textThrows = false,
  } = opts;
  return {
    ok,
    status,
    statusText,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => body,
    text: async () => {
      if (textThrows) throw new Error("no body");
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => fakeRes({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The (url, init) of the Nth (default last) fetch call. */
function lastCall(): [string, FetchInit] {
  const calls = fetchMock.mock.calls as unknown as [string, FetchInit][];
  return calls[calls.length - 1];
}

function bodyJson(init: FetchInit): Record<string, unknown> {
  return JSON.parse((init?.body as string) ?? "{}");
}

function headers(init: FetchInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe("API_BASE", () => {
  it("defaults to the local backend when VITE_API_BASE is unset in test env", () => {
    expect(API_BASE).toBe("http://127.0.0.1:8000");
    expect(api.base).toBe(API_BASE);
  });
});

describe("req: parsing + error handling", () => {
  it("parses a JSON body when content-type is application/json", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ status: "ok" }));
    await expect(api.health()).resolves.toEqual({ status: "ok" });
    expect(lastCall()[0]).toBe(`${API_BASE}/health`);
  });

  it("returns raw text when content-type is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes("plain-text-body", { contentType: "text/plain" }));
    await expect(api.health() as unknown as Promise<string>).resolves.toBe("plain-text-body");
  });

  it("throws an Error carrying status, statusText and the body detail on !ok", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeRes("boom detail", { ok: false, status: 500, statusText: "Server Error", contentType: "text/plain" }),
    );
    await expect(api.status()).rejects.toThrow(/500 Server Error on \/status/);

    fetchMock.mockResolvedValueOnce(
      fakeRes("boom detail", { ok: false, status: 500, statusText: "Server Error", contentType: "text/plain" }),
    );
    await expect(api.status()).rejects.toThrow(/boom detail/);
  });

  it("still throws with an empty detail when reading the error body fails", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeRes(null, { ok: false, status: 404, statusText: "Not Found", textThrows: true }),
    );
    await expect(api.status()).rejects.toThrow(/404 Not Found on \/status/);
  });
});

describe("intake methods", () => {
  it("uploadFile posts multipart FormData with an idempotency key and default uploader", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ doc_id: "D1", timesheet_id: "T1", status: "ingested", routing: "auto", confidence: 0.9 }));
    const file = new File(["hello"], "ts.csv", { type: "text/csv" });
    const out = await api.uploadFile(file);
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/intake/upload`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    const fd = init?.body as FormData;
    expect(fd.get("uploaded_by")).toBe("client");
    expect(fd.get("file")).toBeInstanceOf(File);
    expect(headers(init)["Idempotency-Key"]).toBeTruthy();
    expect(out.doc_id).toBe("D1");
  });

  it("uploadFile honours a custom uploadedBy", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.uploadFile(new File(["x"], "a.csv"), "finops");
    const fd = lastCall()[1]?.body as FormData;
    expect(fd.get("uploaded_by")).toBe("finops");
  });

  it("submitEmail addresses the message to TIA's inbox and passes fields through", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ doc_id: "D2" }));
    await api.submitEmail("the body", "the subject", "sender@x.com", "client");
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/intake/email`);
    expect(init?.method).toBe("POST");
    const b = bodyJson(init);
    expect(b).toMatchObject({
      body: "the body",
      subject: "the subject",
      from_addr: "sender@x.com",
      uploaded_by: "client",
      to_addrs: ["tia@tasc.test"],
    });
    expect(headers(init)["Content-Type"]).toBe("application/json");
    expect(headers(init)["Idempotency-Key"]).toBeTruthy();
  });

  it("submitEmail applies empty-string defaults for optional args", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.submitEmail("only body");
    const b = bodyJson(lastCall()[1]);
    expect(b).toMatchObject({ body: "only body", subject: "", from_addr: "", uploaded_by: "client" });
  });

  it("submitOnlineForm posts to /submit/{clientCode} with the payload", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ client_code: "CL001" }));
    const payload = { period: "2026-06", rows: [{ emp_id: "E1", days_worked: 20 }] };
    await api.submitOnlineForm("CL001", payload);
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/submit/CL001`);
    expect(bodyJson(init)).toEqual(payload);
  });
});

describe("documents + timesheets", () => {
  it("listDocs GETs /documents", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes([{ doc_id: "D1" }]));
    await api.listDocs();
    expect(lastCall()[0]).toBe(`${API_BASE}/documents`);
  });

  it("getDoc GETs /documents/{id}", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ doc: {}, timesheet: null, invoices: [] }));
    await api.getDoc("abc");
    expect(lastCall()[0]).toBe(`${API_BASE}/documents/abc`);
  });

  it("docSourceUrl builds a URL without any fetch", () => {
    expect(api.docSourceUrl("abc")).toBe(`${API_BASE}/documents/abc/source`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("approve posts corrections + by_user (defaults empty corrections/finops)", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ invoice_id: "INV1", amount: 100 }));
    await api.approve("TS1");
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/timesheets/TS1/approve`);
    expect(bodyJson(init)).toEqual({ by_user: "finops", corrections: [] });
  });

  it("approve forwards explicit corrections and user", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.approve("TS1", [{ row_idx: 0, chosen_emp_id: "E9" }], "alice");
    expect(bodyJson(lastCall()[1])).toEqual({ by_user: "alice", corrections: [{ row_idx: 0, chosen_emp_id: "E9" }] });
  });

  it("reject posts a reason", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ status: "rejected" }));
    await api.reject("TS1", "bad data");
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/timesheets/TS1/reject`);
    expect(bodyJson(init)).toEqual({ by_user: "finops", reason: "bad data" });
  });
});

describe("invoices", () => {
  it("listInvoices GETs the base path with no client filter", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes([]));
    await api.listInvoices();
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices`);
  });

  it("listInvoices appends a client_code query when provided", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes([]));
    await api.listInvoices("CL001");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices?client_code=CL001`);
  });

  it("getInvoice + invoiceWhy target the right paths", async () => {
    fetchMock.mockResolvedValue(fakeRes({}));
    await api.getInvoice("I1");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1`);
    await api.invoiceWhy("I1");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/why`);
  });

  it("invoicePdfUrl builds a URL", () => {
    expect(api.invoicePdfUrl("I1")).toBe(`${API_BASE}/invoices/I1/pdf`);
  });

  it("dispatchInvoice + resendInvoiceEmail POST with by_user", async () => {
    fetchMock.mockResolvedValue(fakeRes({}));
    await api.dispatchInvoice("I1");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/dispatch`);
    expect(bodyJson(lastCall()[1])).toEqual({ by_user: "finops" });
    await api.resendInvoiceEmail("I1", "bob");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/resend-email`);
    expect(bodyJson(lastCall()[1])).toEqual({ by_user: "bob" });
  });

  it("clientApprove/clientReject/financeApprove/financeReject post the right bodies", async () => {
    fetchMock.mockResolvedValue(fakeRes({}));
    await api.clientApprove("I1", "client", "looks good");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/client-approve`);
    expect(bodyJson(lastCall()[1])).toEqual({ by_user: "client", reason: "looks good" });

    await api.clientReject("I1", "wrong total");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/client-reject`);
    expect(bodyJson(lastCall()[1])).toEqual({ by_user: "client", reason: "wrong total" });

    await api.financeApprove("I1");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/finance-approve`);
    expect(bodyJson(lastCall()[1])).toEqual({ by_user: "finance", reason: undefined });

    await api.financeReject("I1", "hold");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/finance-reject`);
    expect(bodyJson(lastCall()[1])).toEqual({ by_user: "finance", reason: "hold" });
  });
});

describe("clients + contract", () => {
  it("listClients GETs /clients", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes([]));
    await api.listClients();
    expect(lastCall()[0]).toBe(`${API_BASE}/clients`);
  });

  it("createClient POSTs the payload", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.createClient({ code: "CL9", name: "New Co" });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/clients`);
    expect(bodyJson(init)).toMatchObject({ code: "CL9", name: "New Co" });
  });

  it("updateClientSettings PUTs settings with a JSON content-type and no idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.updateClientSettings("CL1", { markup_pct: 12 });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/clients/CL1/settings`);
    expect(init?.method).toBe("PUT");
    expect(bodyJson(init)).toEqual({ markup_pct: 12 });
    expect(headers(init)["Content-Type"]).toBe("application/json");
    expect(headers(init)["Idempotency-Key"]).toBeUndefined();
  });

  it("getContract returns parsed JSON on success", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ id: "C1", client_code: "CL1" }));
    await expect(api.getContract("CL1")).resolves.toMatchObject({ id: "C1" });
    expect(lastCall()[0]).toBe(`${API_BASE}/contracts/CL1`);
  });

  it("getContract returns null on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(null, { ok: false, status: 404, statusText: "NF" }));
    await expect(api.getContract("CL1")).resolves.toBeNull();
  });

  it("getContract swallows network errors and returns null", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(api.getContract("CL1")).resolves.toBeNull();
  });
});

describe("queries", () => {
  it("raiseQuery POSTs to the client queries collection", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ id: "Q1", status: "open", client_code: "CL1" }));
    await api.raiseQuery("CL1", { subject: "Dispute" });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/clients/CL1/queries`);
    expect(bodyJson(init)).toEqual({ subject: "Dispute" });
  });

  it("listQueries GETs the client queries collection", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes([]));
    await api.listQueries("CL1");
    expect(lastCall()[0]).toBe(`${API_BASE}/clients/CL1/queries`);
  });

  it("replyToQuery POSTs the reply body", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ id: "Q1", status: "answered", thread: [] }));
    await api.replyToQuery("Q1", { body: "here you go", close: true });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/queries/Q1/reply`);
    expect(bodyJson(init)).toEqual({ body: "here you go", close: true });
  });
});

describe("chat /qa", () => {
  it("qa POSTs the question and optional entity_context", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ answer: "hi", citations: [], tool_calls: [], model: "m" }));
    await api.qa("what is up?", { kind: "invoice", id: "I1" });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/qa`);
    expect(bodyJson(init)).toEqual({ question: "what is up?", entity_context: { kind: "invoice", id: "I1" } });
  });
});

describe("metrics + queues", () => {
  it("routes each KPI/queue endpoint to its GET path", async () => {
    fetchMock.mockResolvedValue(fakeRes({}));
    const cases: [() => Promise<unknown>, string][] = [
      [() => api.metricsStp(), "/metrics/stp"],
      [() => api.metricsTimeToInvoice(), "/metrics/time-to-invoice"],
      [() => api.metricsAccuracy(), "/metrics/accuracy"],
      [() => api.metricsHeadcount(), "/metrics/headcount"],
      [() => api.metricsSla(), "/metrics/sla"],
      [() => api.financeQueue(), "/finance/queue"],
      [() => api.dispatchTracking(), "/dispatch/tracking"],
      [() => api.evalSummary(), "/eval"],
      [() => api.listRules(), "/rules"],
      [() => api.verifyAuditChain(), "/audit/verify"],
    ];
    for (const [call, path] of cases) {
      await call();
      expect(lastCall()[0]).toBe(`${API_BASE}${path}`);
    }
  });

  it("runEval + demoReset are POSTs", async () => {
    fetchMock.mockResolvedValue(fakeRes({}));
    await api.runEval();
    expect(lastCall()[0]).toBe(`${API_BASE}/eval/run`);
    expect(lastCall()[1]?.method).toBe("POST");
    await api.demoReset();
    expect(lastCall()[0]).toBe(`${API_BASE}/admin/demo-reset`);
    expect(lastCall()[1]?.method).toBe("POST");
  });
});

describe("static artifact URLs (no fetch)", () => {
  it("encode the period path segment", () => {
    expect(api.consolidatedExcelUrl("CL1", "2026-06")).toBe(`${API_BASE}/consolidate/CL1/2026-06.xlsx`);
    expect(api.wpsSifUrl("CL1", "2026-06")).toBe(`${API_BASE}/payroll/sif/CL1/2026-06.sif`);
    expect(api.clientAuditBundleUrl("CL1", "2026-Q2")).toBe(`${API_BASE}/client/CL1/audit/2026-Q2.zip`);
    // encodeURIComponent kicks in for characters that need escaping
    expect(api.consolidatedExcelUrl("CL1", "2026/06")).toContain("2026%2F06.xlsx");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("events feed", () => {
  it("listEvents defaults to limit=100 with no entity filter", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes([]));
    await api.listEvents();
    expect(lastCall()[0]).toBe(`${API_BASE}/events?limit=100`);
  });

  it("listEvents encodes the entity id and custom limit", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes([]));
    await api.listEvents("I 1", 5);
    expect(lastCall()[0]).toBe(`${API_BASE}/events?entity_id=I%201&limit=5`);
  });
});

describe("payments + statement + periods", () => {
  it("payInvoice POSTs a payment with an idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ id: "P1", receipt_number: "R1", status: "received" }));
    await api.payInvoice("I1", { amount: 100, method: "wire" });
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/invoices/I1/payments`);
    expect(bodyJson(init)).toEqual({ amount: 100, method: "wire" });
    expect(headers(init)["Idempotency-Key"]).toBeTruthy();
  });

  it("listPayments GETs the payment collection", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes([]));
    await api.listPayments("I1");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/payments`);
  });

  it("clientStatement defaults to 12 months and honours an override", async () => {
    fetchMock.mockResolvedValue(fakeRes({}));
    await api.clientStatement("CL1");
    expect(lastCall()[0]).toBe(`${API_BASE}/client/CL1/statement?months=12`);
    await api.clientStatement("CL1", 3);
    expect(lastCall()[0]).toBe(`${API_BASE}/client/CL1/statement?months=3`);
  });

  it("closePeriod + reopenPeriod POST to the period sub-resource with encoded period", async () => {
    fetchMock.mockResolvedValue(fakeRes({}));
    await api.closePeriod("CL1", "2026-06");
    expect(lastCall()[0]).toBe(`${API_BASE}/clients/CL1/periods/2026-06/close`);
    expect(lastCall()[1]?.method).toBe("POST");
    await api.reopenPeriod("CL1", "2026-06");
    expect(lastCall()[0]).toBe(`${API_BASE}/clients/CL1/periods/2026-06/reopen`);
  });
});

describe("notifications + client users", () => {
  it("notifications defaults to the client persona + limit 30", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes([]));
    await api.notifications();
    expect(lastCall()[0]).toBe(`${API_BASE}/notifications?persona=client&limit=30`);
  });

  it("notifications adds a client_code when provided", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes([]));
    await api.notifications("finance", "CL1", 5);
    expect(lastCall()[0]).toBe(`${API_BASE}/notifications?persona=finance&client_code=CL1&limit=5`);
  });

  it("listClientUsers GETs + setClientUsers PUTs the users collection", async () => {
    fetchMock.mockResolvedValue(fakeRes([]));
    await api.listClientUsers("CL1");
    expect(lastCall()[0]).toBe(`${API_BASE}/clients/CL1/users`);
    const users = [{ email: "a@x.com", name: "A", role: "admin" as const }];
    await api.setClientUsers("CL1", users);
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/clients/CL1/users`);
    expect(init?.method).toBe("PUT");
    expect(bodyJson(init)).toEqual(users);
  });
});

describe("dispatch queue + audit + clawback", () => {
  it("dispatchQueue + invoiceAudit GET their paths", async () => {
    fetchMock.mockResolvedValue(fakeRes({}));
    await api.dispatchQueue("CL1");
    expect(lastCall()[0]).toBe(`${API_BASE}/dispatch/CL1/queue`);
    await api.invoiceAudit("I1");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/audit`);
  });

  it("clawbackEligibility GETs the eligibility path", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.clawbackEligibility("I1");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/clawback-eligibility`);
  });

  it("clawback POSTs with a caller-supplied idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.clawback("I1", { reason_code: "DUPLICATE" }, "key-123");
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/invoices/I1/clawback`);
    expect(bodyJson(init)).toEqual({ reason_code: "DUPLICATE" });
    expect(headers(init)["Idempotency-Key"]).toBe("key-123");
  });

  it("clawback generates an idempotency key when none is supplied", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.clawback("I1", { reason_code: "OTHER" });
    expect(headers(lastCall()[1])["Idempotency-Key"]).toBeTruthy();
  });
});

describe("leakage + SAP B1", () => {
  it("metricsLeakage GETs the bare path when no filters are set", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.metricsLeakage();
    expect(lastCall()[0]).toBe(`${API_BASE}/metrics/leakage`);
  });

  it("metricsLeakage builds a query string from period + client", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.metricsLeakage("2026-06", "CL1");
    const url = lastCall()[0];
    expect(url).toContain("/metrics/leakage?");
    expect(url).toContain("period=2026-06");
    expect(url).toContain("client_code=CL1");
  });

  it("recoverLeakage POSTs the reason + defaults", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.recoverLeakage("E1", "2026-06");
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/finance/leakage/E1/recover`);
    expect(bodyJson(init)).toEqual({ period: "2026-06", reason: "no_timesheet", by_user: "finops" });
  });

  it("recoverLeakage encodes the employee id and forwards a custom reason", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.recoverLeakage("E/1", "2026-06", "missing_overtime", "bob");
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/finance/leakage/E%2F1/recover`);
    expect(bodyJson(init)).toMatchObject({ reason: "missing_overtime", by_user: "bob" });
  });

  it("sapB1Payload GETs the payload path", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({}));
    await api.sapB1Payload("I1");
    expect(lastCall()[0]).toBe(`${API_BASE}/invoices/I1/sap-b1-payload`);
  });
});

/** A fake ReadableStream reader that emits the given string chunks in order. */
function readerFrom(chunks: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    read: async () => {
      if (i < chunks.length) {
        return { value: enc.encode(chunks[i++]), done: false };
      }
      return { value: undefined, done: true };
    },
  };
}

function streamRes(chunks: string[], opts: { ok?: boolean; status?: number; text?: string } = {}) {
  const { ok = true, status = 200, text = "" } = opts;
  return {
    ok,
    status,
    body: ok ? { getReader: () => readerFrom(chunks) } : null,
    text: async () => text,
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("qaStream (SSE decoder)", () => {
  it("POSTs to /qa/stream with the question, context and history", async () => {
    fetchMock.mockResolvedValueOnce(streamRes([`data: ${JSON.stringify({ type: "done", model: "m", citations: [], tool_calls_summary: [] })}\n\n`]));
    await collect(api.qaStream("q?", { kind: "invoice", id: "I1" }, "CL1", undefined, [{ role: "user", content: "hi" }]));
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/qa/stream`);
    expect(init?.method).toBe("POST");
    expect(bodyJson(init)).toEqual({
      question: "q?",
      entity_context: { kind: "invoice", id: "I1" },
      client_scope: "CL1",
      history: [{ role: "user", content: "hi" }],
    });
  });

  it("yields each SSE event and parses the JSON payload", async () => {
    const events = [
      { type: "tool", name: "verify_audit_chain", args: {}, status: "running" },
      { type: "token", content: "Hello " },
      { type: "token", content: "world" },
      { type: "done", model: "gpt", citations: [], tool_calls_summary: [] },
    ];
    fetchMock.mockResolvedValueOnce(streamRes(events.map((e) => `data: ${JSON.stringify(e)}\n\n`)));
    const got = await collect(api.qaStream("q?"));
    expect(got).toEqual(events);
  });

  it("handles frames split across chunk boundaries", async () => {
    const ev = { type: "token", content: "chunked" };
    const whole = `data: ${JSON.stringify(ev)}\n\n`;
    const mid = Math.floor(whole.length / 2);
    fetchMock.mockResolvedValueOnce(streamRes([whole.slice(0, mid), whole.slice(mid)]));
    const got = await collect(api.qaStream("q?"));
    expect(got).toEqual([ev]);
  });

  it("skips non-data lines, blank data lines and malformed JSON", async () => {
    const good = { type: "token", content: "ok" };
    const frame =
      `event: ping\n` + // non-data line -> ignored
      `data:\n` + // blank payload -> ignored
      `data: {not-json\n` + // malformed -> swallowed
      `\n` +
      `data: ${JSON.stringify(good)}\n\n`;
    fetchMock.mockResolvedValueOnce(streamRes([frame]));
    const got = await collect(api.qaStream("q?"));
    expect(got).toEqual([good]);
  });

  it("throws with the response body when the stream request is not ok", async () => {
    fetchMock.mockResolvedValueOnce(streamRes([], { ok: false, status: 502, text: "upstream boom" }));
    await expect(collect(api.qaStream("q?"))).rejects.toThrow(/qa\/stream 502: upstream boom/);
  });
});
