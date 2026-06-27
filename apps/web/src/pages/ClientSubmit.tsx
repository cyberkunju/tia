import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, FileText, ArrowRight } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib";
import { PageHeader, Panel, Spinner } from "../ui";
import { usePersona } from "../store";
import { UploadReceipt } from "../components/UploadReceipt";

const SAMPLE_EMAILS: Record<string, string> = {
  "Name only (ambiguous)": `Subject: Payout request\n\nClient: Majid Al Futtaim Retail LLC\nPeriod: June 2026\n\nFatima Khan - 23 days, total AED 12000\n\nRegards,\nOperations`,
  "From employee (Emp ID)": `Subject: My timesheet\n\nHi Payroll,\n\nMy employee id is EMP10001 and I worked 22 days this month with 2 OT hours.\n\nRegards,\nCarlos`,
  "Client roster": `Subject: Monthly timesheet\n\nClient: Emirates Steel Industries LLC\nPeriod: June 2026\n\nCarlos Smith - 22 days\nAhmed Khan - 20 days, 4 OT hours\nMeera Al Rashid - 21 days\n\nApproved by: Site Manager`,
  "Leave + reimbursements": `Subject: Leave and reimbursements\n\nClient: Emirates Steel Industries LLC\nPeriod: June 2026\n\nEMP10001 Carlos Smith - 20 days, leave: AL, reimbursement AED 250 for taxi\nEMP10002 Ahmed Khan - 22 days, claim AED 120 for parking\n\nRegards,\nFinance`,
};

const PIPELINE = [
  ["Ingest", "Captured from any channel"],
  ["Extract", "OCR / parse to structured rows"],
  ["Resolve", "Match associates (Hungarian)"],
  ["Validate", "BTP rules + confidence"],
  ["Invoice", "Tax invoice generated"],
] as const;

type Result = { doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number };

export function ClientSubmit() {
  const qc = useQueryClient();
  const { currentClientCode } = usePersona();
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: api.listClients });
  const clientName = clients?.find((c) => c.code === currentClientCode)?.name;
  const [tab, setTab] = useState<"upload" | "email">("upload");
  const [emailBody, setEmailBody] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const onDone = (r: Result) => { setResult(r); qc.invalidateQueries({ queryKey: ["docs"] }); };
  const upload = useMutation({ mutationFn: (file: File) => api.uploadFile(file), onSuccess: onDone });
  const email = useMutation({ mutationFn: () => api.submitEmail(emailBody, emailSubject), onSuccess: onDone });

  return (
    <div>
      <PageHeader
        icon={Upload}
        title={clientName ? `Submit timesheet · ${clientName}` : "Submit timesheet"}
        description={
          currentClientCode
            ? <span>Submitting on behalf of <span className="font-mono">{currentClientCode}</span> — upload a file or paste an email body. Any of the 7 shapes. The agent does the rest.</span>
            : "Upload a file or paste an email body — any of the 7 shapes. The agent does the rest."
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        {/* Form — fills two thirds */}
        <div className="lg:col-span-2 space-y-4">
          <div className="inline-flex p-1 rounded-lg bg-ink-100 border border-ink-200">
            {([["upload", "File upload", Upload], ["email", "Email body", FileText]] as const).map(([id, label, Icon]) => (
              <button key={id} onClick={() => setTab(id)}
                className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors", tab === id ? "bg-white text-ink-900 shadow-xs" : "text-ink-500 hover:text-ink-800")}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>

          {tab === "upload" && (
            <Panel>
              <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-ink-300 bg-ink-50 px-6 py-16 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50/30 transition-colors">
                <span className="grid place-items-center h-11 w-11 rounded-lg bg-white border border-ink-200 text-ink-500"><Upload size={20} /></span>
                <span className="text-sm font-medium text-ink-700">Click to select a file</span>
                <span className="text-xs text-ink-400">xlsx · csv · pdf · png · jpg · eml · txt</span>
                <input type="file" className="hidden" accept=".xlsx,.xls,.csv,.eml,.txt,.png,.jpg,.jpeg,.pdf"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); }} />
              </label>
              <p className="text-xs text-ink-400 mt-3">Excel and email parse instantly. Handwritten images route through GLM-OCR on Modal (warm ≈ 2s, cold up to ≈ 90s).</p>
              {upload.isPending && <p className="flex items-center gap-2 text-sm text-brand-700 mt-3"><Spinner /> Processing…</p>}
            </Panel>
          )}

          {tab === "email" && (
            <Panel>
              <label className="field-label">Try a sample</label>
              <div className="flex flex-wrap gap-2 mb-4">
                {Object.entries(SAMPLE_EMAILS).map(([label, body]) => (
                  <button key={label} className="btn-outline btn-sm" onClick={() => { setEmailSubject(label); setEmailBody(body); }}>{label}</button>
                ))}
              </div>
              <label className="field-label">Subject</label>
              <input className="input mb-3" placeholder="Optional" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} />
              <label className="field-label">Body</label>
              <textarea className="textarea h-64 font-mono text-xs" placeholder="Paste the email body here…" value={emailBody} onChange={(e) => setEmailBody(e.target.value)} />
              <div className="flex justify-end mt-3">
                <button className="btn-primary" disabled={!emailBody || email.isPending} onClick={() => email.mutate()}>
                  {email.isPending ? <><Spinner /> Submitting…</> : <>Submit <ArrowRight size={15} /></>}
                </button>
              </div>
            </Panel>
          )}
        </div>

        {/* Context column — fills the last third */}
        <div className="space-y-4">
          {result && <UploadReceipt docId={result.doc_id} />}

          <Panel title="How TIA processes this">
            <ol className="space-y-3">
              {PIPELINE.map(([t, d], i) => (
                <li key={t} className="flex gap-3">
                  <span className="grid place-items-center h-6 w-6 rounded-full bg-brand-50 text-brand-700 text-xs font-semibold ring-1 ring-brand-100 shrink-0">{i + 1}</span>
                  <div><div className="text-sm font-medium text-ink-800">{t}</div><div className="text-xs text-ink-500">{d}</div></div>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Channels">
            <div className="flex flex-wrap gap-2">
              {["Email", "Portal upload", "WhatsApp"].map((c) => <span key={c} className="badge-blue">{c}</span>)}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
