import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { routingBadgeClass, statusBadgeClass } from "../lib";

const SAMPLE_EMAILS = {
  "Case 1 — name only (Fatima Khan, ambiguous)": `Subject: Payout request\n\nClient: Majid Al Futtaim Retail LLC\nPeriod: June 2026\n\nFatima Khan - 23 days, total AED 12000\n\nRegards,\nOperations`,
  "Case 2 — from employee (Emp ID, days)": `Subject: My timesheet\n\nHi Payroll,\n\nMy employee id is EMP10001 and I worked 22 days this month with 2 OT hours.\n\nRegards,\nCarlos`,
  "Case 3 — client roster (full month)": `Subject: Monthly timesheet\n\nClient: Emirates Steel Industries LLC\nPeriod: June 2026\n\nCarlos Smith - 22 days\nAhmed Khan - 20 days, 4 OT hours\nMeera Al Rashid - 21 days\n\nApproved by: Site Manager`,
  "Case 6 — structured (leave + reimbursements)": `Subject: Leave and reimbursements\n\nClient: Emirates Steel Industries LLC\nPeriod: June 2026\n\nEMP10001 Carlos Smith - 20 days, leave: AL, reimbursement AED 250 for taxi\nEMP10002 Ahmed Khan - 22 days, claim AED 120 for parking\n\nRegards,\nFinance`,
};

export function ClientSubmit() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"upload" | "email">("upload");
  const [emailBody, setEmailBody] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [result, setResult] = useState<{ doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number } | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadFile(file),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ["docs"] });
    },
  });
  const email = useMutation({
    mutationFn: () => api.submitEmail(emailBody, emailSubject),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ["docs"] });
    },
  });

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold mb-1">Submit timesheet</h1>
      <p className="text-sm text-ink-600 mb-4">Upload a file, paste an email body — anything goes; the agent figures it out.</p>

      <div className="flex gap-1 mb-4">
        {[
          { id: "upload", label: "Upload (xlsx, pdf, png)" },
          { id: "email", label: "Email body" },
        ].map((t) => (
          <button
            key={t.id}
            className={`px-3 py-2 text-sm rounded-md ${tab === t.id ? "bg-brand-50 text-brand-700 font-medium" : "text-ink-600 hover:bg-ink-100"}`}
            onClick={() => setTab(t.id as "upload" | "email")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "upload" && (
        <div className="card p-6">
          <label className="block">
            <span className="block text-sm font-medium mb-2">Pick a file</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv,.eml,.txt,.png,.jpg,.jpeg,.pdf"
              className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-brand-600 file:text-white file:font-medium hover:file:bg-brand-700 cursor-pointer"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); }}
            />
          </label>
          <p className="text-xs text-ink-500 mt-3">
            Excel + email parse instantly. Handwritten images go through GLM-OCR on Modal (warm: ~2s, cold: up to ~90s).
          </p>
          {upload.isPending && <p className="text-sm text-brand-700 mt-3">Processing…</p>}
        </div>
      )}

      {tab === "email" && (
        <div className="card p-6 space-y-3">
          <div>
            <span className="block text-sm font-medium mb-1">Try a sample</span>
            <div className="flex flex-wrap gap-2">
              {Object.entries(SAMPLE_EMAILS).map(([label, body]) => (
                <button
                  key={label}
                  className="btn-outline text-xs"
                  onClick={() => { setEmailSubject(label); setEmailBody(body); }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <input
            className="w-full border border-ink-200 rounded-md px-3 py-2 text-sm"
            placeholder="Subject (optional)"
            value={emailSubject}
            onChange={(e) => setEmailSubject(e.target.value)}
          />
          <textarea
            className="w-full border border-ink-200 rounded-md px-3 py-2 text-sm h-56 font-mono"
            placeholder="Paste the email body here…"
            value={emailBody}
            onChange={(e) => setEmailBody(e.target.value)}
          />
          <div className="flex justify-end">
            <button
              className="btn-primary"
              disabled={!emailBody || email.isPending}
              onClick={() => email.mutate()}
            >
              {email.isPending ? "Submitting…" : "Submit"}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="card p-5 mt-5">
          <div className="text-sm">
            <span className="text-ink-500">Doc</span>{" "}
            <span className="font-mono text-xs">{result.doc_id}</span>{" "}
            <span className={statusBadgeClass(result.status)}>{result.status}</span>{" "}
            <span className={routingBadgeClass(result.routing)}>{result.routing}</span>
          </div>
          <div className="mt-3 flex gap-2">
            <Link to={`/finops/review/${result.doc_id}`} className="btn-primary text-sm">Open in FinOps Review →</Link>
            <Link to="/client/invoices" className="btn-outline text-sm">View invoices</Link>
          </div>
        </div>
      )}
    </div>
  );
}
