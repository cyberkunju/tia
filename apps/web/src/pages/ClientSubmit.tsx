import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Upload, FileText, ArrowRight, CheckCircle2 } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib";
import { PageHeader, Panel, StatusBadge, RoutingBadge, Spinner } from "../ui";

const SAMPLE_EMAILS: Record<string, string> = {
  "Name only (ambiguous)": `Subject: Payout request\n\nClient: Majid Al Futtaim Retail LLC\nPeriod: June 2026\n\nFatima Khan - 23 days, total AED 12000\n\nRegards,\nOperations`,
  "From employee (Emp ID)": `Subject: My timesheet\n\nHi Payroll,\n\nMy employee id is EMP10001 and I worked 22 days this month with 2 OT hours.\n\nRegards,\nCarlos`,
  "Client roster": `Subject: Monthly timesheet\n\nClient: Emirates Steel Industries LLC\nPeriod: June 2026\n\nCarlos Smith - 22 days\nAhmed Khan - 20 days, 4 OT hours\nMeera Al Rashid - 21 days\n\nApproved by: Site Manager`,
  "Leave + reimbursements": `Subject: Leave and reimbursements\n\nClient: Emirates Steel Industries LLC\nPeriod: June 2026\n\nEMP10001 Carlos Smith - 20 days, leave: AL, reimbursement AED 250 for taxi\nEMP10002 Ahmed Khan - 22 days, claim AED 120 for parking\n\nRegards,\nFinance`,
};

type Result = { doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number };

export function ClientSubmit() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"upload" | "email">("upload");
  const [emailBody, setEmailBody] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const onDone = (r: Result) => { setResult(r); qc.invalidateQueries({ queryKey: ["docs"] }); };
  const upload = useMutation({ mutationFn: (file: File) => api.uploadFile(file), onSuccess: onDone });
  const email = useMutation({ mutationFn: () => api.submitEmail(emailBody, emailSubject), onSuccess: onDone });

  return (
    <div className="max-w-3xl">
      <PageHeader
        icon={Upload}
        title="Submit timesheet"
        description="Upload a file or paste an email body — any of the 7 shapes. The agent does the rest."
      />

      <div className="inline-flex p-1 rounded-lg bg-ink-100 border border-ink-200 mb-4">
        {([["upload", "File upload", Upload], ["email", "Email body", FileText]] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
              tab === id ? "bg-white text-ink-900 shadow-xs" : "text-ink-500 hover:text-ink-800",
            )}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === "upload" && (
        <Panel>
          <label className="field-label">Choose a file</label>
          <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-ink-300 bg-ink-50 px-6 py-10 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50/30 transition-colors">
            <span className="grid place-items-center h-10 w-10 rounded-lg bg-white border border-ink-200 text-ink-500">
              <Upload size={18} />
            </span>
            <span className="text-sm font-medium text-ink-700">Click to select a file</span>
            <span className="text-xs text-ink-400">xlsx · csv · pdf · png · jpg · eml · txt</span>
            <input
              type="file"
              className="hidden"
              accept=".xlsx,.xls,.csv,.eml,.txt,.png,.jpg,.jpeg,.pdf"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); }}
            />
          </label>
          <p className="text-xs text-ink-400 mt-3">
            Excel and email parse instantly. Handwritten images route through GLM-OCR on Modal (warm ≈ 2s, cold up to ≈ 90s).
          </p>
          {upload.isPending && <p className="flex items-center gap-2 text-sm text-brand-700 mt-3"><Spinner /> Processing…</p>}
        </Panel>
      )}

      {tab === "email" && (
        <Panel>
          <label className="field-label">Try a sample</label>
          <div className="flex flex-wrap gap-2 mb-4">
            {Object.entries(SAMPLE_EMAILS).map(([label, body]) => (
              <button key={label} className="btn-outline btn-sm" onClick={() => { setEmailSubject(label); setEmailBody(body); }}>
                {label}
              </button>
            ))}
          </div>
          <label className="field-label">Subject</label>
          <input className="input mb-3" placeholder="Optional" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} />
          <label className="field-label">Body</label>
          <textarea
            className="textarea h-52 font-mono text-xs"
            placeholder="Paste the email body here…"
            value={emailBody}
            onChange={(e) => setEmailBody(e.target.value)}
          />
          <div className="flex justify-end mt-3">
            <button className="btn-primary" disabled={!emailBody || email.isPending} onClick={() => email.mutate()}>
              {email.isPending ? <><Spinner /> Submitting…</> : <>Submit <ArrowRight size={15} /></>}
            </button>
          </div>
        </Panel>
      )}

      {result && (
        <div className="card mt-4 p-4 animate-fade-in">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 size={16} className="text-emerald-600" />
            <span className="font-medium text-ink-800">Received</span>
            <span className="font-mono text-xs text-ink-400">{result.doc_id.slice(0, 8)}</span>
            <StatusBadge status={result.status} />
            <RoutingBadge routing={result.routing} />
          </div>
          <div className="flex gap-2 mt-3">
            <Link to={`/finops/review/${result.doc_id}`} className="btn-primary btn-sm">Open in FinOps review <ArrowRight size={14} /></Link>
            <Link to="/client/invoices" className="btn-outline btn-sm">View invoices</Link>
          </div>
        </div>
      )}
    </div>
  );
}
