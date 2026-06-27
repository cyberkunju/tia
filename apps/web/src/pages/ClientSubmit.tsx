import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import {
  Upload, Camera, FileSpreadsheet, FileImage, FileText, Mail, FileEdit,
  CheckCircle2, AlertCircle, Loader2, Building2, ArrowRight, ReceiptText,
} from "lucide-react";
import { api } from "../api";
import type { ApiClient } from "../types";
import { PageHeader, Panel, ConfidenceBadge, RoutingBadge } from "../ui";
import { cn } from "../lib";

type RowForm = { emp_id: string; employee_name: string; days_worked: string; ot_hours: string; leave: string };

const EMPTY_ROW: RowForm = { emp_id: "", employee_name: "", days_worked: "", ot_hours: "", leave: "" };

const ACCEPT_MIME =
  ".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.eml,.txt," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "application/vnd.ms-excel,application/pdf,image/png,image/jpeg," +
  "message/rfc822,text/plain";

function iconForFile(name: string) {
  const lo = name.toLowerCase();
  if (lo.endsWith(".xlsx") || lo.endsWith(".xls") || lo.endsWith(".csv")) return FileSpreadsheet;
  if (lo.endsWith(".pdf")) return FileText;
  if (lo.endsWith(".png") || lo.endsWith(".jpg") || lo.endsWith(".jpeg")) return FileImage;
  if (lo.endsWith(".eml")) return Mail;
  return FileText;
}

export function ClientSubmit() {
  const { clientCode } = useParams<{ clientCode?: string }>();
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: api.listClients });
  const client = useMemo<ApiClient | undefined>(
    () => clients?.find((c) => c.code === clientCode),
    [clients, clientCode],
  );

  const [tab, setTab] = useState<"upload" | "form" | "email">("upload");
  const [result, setResult] = useState<null | {
    doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number;
  }>(null);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Upload}
        title={client ? `Submit timesheet · ${client.name}` : "Submit timesheet"}
        description={
          client
            ? <span>Submitting on behalf of <span className="font-mono">{client.code}</span></span>
            : "Drop any timesheet — Excel, PDF, photo of a paper form, plain email body, or fill the inline form."
        }
        actions={
          <Link to="/client/invoices" className="btn-outline btn-sm">
            View my invoices <ArrowRight size={14} />
          </Link>
        }
      />

      {/* Tab switcher */}
      <div className="card-flush">
        <div className="flex border-b border-ink-200 px-3">
          {[
            { id: "upload" as const, label: "Upload / Photo", icon: Upload },
            { id: "form" as const, label: "Online form", icon: FileEdit },
            { id: "email" as const, label: "Paste email body", icon: Mail },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setResult(null); }}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === t.id
                  ? "border-brand-500 text-brand-700"
                  : "border-transparent text-ink-500 hover:text-ink-800",
              )}
            >
              <t.icon size={15} />
              {t.label}
            </button>
          ))}
        </div>

        <div className="p-5">
          {tab === "upload" && <UploadTab onResult={setResult} />}
          {tab === "form" && client && <FormTab clientCode={client.code} onResult={setResult} />}
          {tab === "form" && !client && <PickClient clients={clients ?? []} />}
          {tab === "email" && <EmailTab onResult={setResult} />}
        </div>
      </div>

      {result && <ResultCard result={result} />}
    </div>
  );
}

/* ── Upload tab ─────────────────────────────────────────────── */

function UploadTab({ onResult }: { onResult: (r: { doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number }) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const camInput = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (f: File) => api.uploadFile(f, "client"),
    onSuccess: onResult,
  });

  return (
    <div>
      <label
        onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f) setFile(f);
        }}
        className={cn(
          "block rounded-xl border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-all",
          drag
            ? "border-brand-500 bg-brand-50"
            : "border-ink-300 bg-ink-50/50 hover:bg-ink-50 hover:border-ink-400",
        )}
      >
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT_MIME}
          className="sr-only"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <input
          ref={camInput}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {!file ? (
          <>
            <span className="grid place-items-center mx-auto h-12 w-12 rounded-full bg-brand-100 text-brand-700">
              <Upload size={22} />
            </span>
            <p className="mt-3 text-base font-semibold text-ink-900">
              Drop your timesheet here
            </p>
            <p className="mt-1 text-xs text-ink-500">
              Excel · PDF · photo (handwritten) · email · text — any format
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); fileInput.current?.click(); }}
                className="btn-outline btn-sm"
              >
                Choose file
              </button>
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); camInput.current?.click(); }}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-400 text-teal-950 text-xs font-semibold px-3 py-1.5 shadow-xs"
              >
                <Camera size={14} /> Use camera
              </button>
            </div>
          </>
        ) : (
          <FileChip file={file} onClear={() => setFile(null)} />
        )}
      </label>

      {file && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={() => setFile(null)} className="btn-outline btn-sm">Cancel</button>
          <button
            onClick={() => file && upload.mutate(file)}
            disabled={upload.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-400 text-teal-950 text-sm font-semibold px-4 py-2 shadow-sm disabled:opacity-60"
          >
            {upload.isPending ? <><Loader2 className="animate-spin" size={14} /> Submitting…</> : <>Submit <ArrowRight size={14} /></>}
          </button>
        </div>
      )}

      {upload.isError && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 text-red-900 text-sm px-3 py-2">
          <AlertCircle size={14} className="inline mr-1.5" />
          {String(upload.error)}
        </div>
      )}
    </div>
  );
}

function FileChip({ file, onClear }: { file: File; onClear: () => void }) {
  const Icon = iconForFile(file.name);
  return (
    <div className="inline-flex items-center gap-3 rounded-lg bg-white border border-ink-200 px-4 py-3 shadow-xs">
      <Icon size={20} className="text-brand-700 shrink-0" />
      <div className="text-left">
        <div className="text-sm font-medium text-ink-900">{file.name}</div>
        <div className="text-2xs text-ink-500">{Math.round(file.size / 1024)} KB · {file.type || "—"}</div>
      </div>
      <button onClick={(e) => { e.preventDefault(); onClear(); }} className="text-ink-400 hover:text-ink-700 text-sm ml-2">Remove</button>
    </div>
  );
}

/* ── Online form tab (Part 1.1 channel) ────────────────────── */

function FormTab({ clientCode, onResult }: { clientCode: string; onResult: (r: { doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number }) => void }) {
  const today = new Date();
  const [period, setPeriod] = useState(`${today.toLocaleString("en-US", { month: "long" })} ${today.getFullYear()}`);
  const [submittedBy, setSubmittedBy] = useState("");
  const [rows, setRows] = useState<RowForm[]>([ { ...EMPTY_ROW }, { ...EMPTY_ROW } ]);
  const [notes, setNotes] = useState("");

  const submit = useMutation({
    mutationFn: () => api.submitOnlineForm(clientCode, {
      period,
      submitted_by: submittedBy || undefined,
      notes: notes || undefined,
      rows: rows
        .filter((r) => r.emp_id || r.employee_name || r.days_worked)
        .map((r) => ({
          emp_id: r.emp_id || undefined,
          employee_name: r.employee_name || undefined,
          days_worked: r.days_worked ? Number(r.days_worked) : undefined,
          ot_hours: r.ot_hours ? Number(r.ot_hours) : undefined,
          leave_codes: r.leave ? r.leave.split(/[\s,]+/).filter(Boolean) : undefined,
        })),
    }),
    onSuccess: onResult,
  });

  function set(i: number, key: keyof RowForm, v: string) {
    setRows((arr) => arr.map((r, idx) => idx === i ? { ...r, [key]: v } : r));
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label className="field-label">Period</label>
          <input className="input" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="June 2026" />
        </div>
        <div>
          <label className="field-label">Submitted by (your email — optional)</label>
          <input className="input" value={submittedBy} onChange={(e) => setSubmittedBy(e.target.value)} placeholder="site-manager@yourco.com" />
        </div>
      </div>

      <div className="rounded-lg border border-ink-200 overflow-hidden mb-3">
        <table className="w-full text-sm">
          <thead className="bg-ink-50">
            <tr>
              <th className="text-left px-3 py-2 text-2xs uppercase tracking-wide text-ink-500 font-semibold">Emp ID</th>
              <th className="text-left px-3 py-2 text-2xs uppercase tracking-wide text-ink-500 font-semibold">Employee name</th>
              <th className="text-right px-3 py-2 text-2xs uppercase tracking-wide text-ink-500 font-semibold w-20">Days</th>
              <th className="text-right px-3 py-2 text-2xs uppercase tracking-wide text-ink-500 font-semibold w-20">OT hrs</th>
              <th className="text-left px-3 py-2 text-2xs uppercase tracking-wide text-ink-500 font-semibold w-32">Leave</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-ink-100">
                <td className="px-2 py-1"><input className="w-full text-sm font-mono bg-transparent border-0 px-1 py-1 focus:outline-none focus:bg-white" placeholder="EMP10001" value={r.emp_id} onChange={(e) => set(i, "emp_id", e.target.value)} /></td>
                <td className="px-2 py-1"><input className="w-full text-sm bg-transparent border-0 px-1 py-1 focus:outline-none focus:bg-white" placeholder="Carlos Smith" value={r.employee_name} onChange={(e) => set(i, "employee_name", e.target.value)} /></td>
                <td className="px-2 py-1"><input className="w-full text-sm tnum text-right bg-transparent border-0 px-1 py-1 focus:outline-none focus:bg-white" placeholder="22" value={r.days_worked} onChange={(e) => set(i, "days_worked", e.target.value)} /></td>
                <td className="px-2 py-1"><input className="w-full text-sm tnum text-right bg-transparent border-0 px-1 py-1 focus:outline-none focus:bg-white" placeholder="0" value={r.ot_hours} onChange={(e) => set(i, "ot_hours", e.target.value)} /></td>
                <td className="px-2 py-1"><input className="w-full text-sm bg-transparent border-0 px-1 py-1 focus:outline-none focus:bg-white" placeholder="AL, SICK" value={r.leave} onChange={(e) => set(i, "leave", e.target.value)} /></td>
                <td className="px-2"><button onClick={() => setRows((arr) => arr.filter((_, idx) => idx !== i))} className="text-ink-400 hover:text-red-600 text-xs">×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={() => setRows((arr) => [...arr, { ...EMPTY_ROW }])} className="w-full text-left px-3 py-2 text-xs text-brand-700 hover:bg-brand-50 border-t border-ink-100 font-medium">
          + add row
        </button>
      </div>

      <div className="mb-4">
        <label className="field-label">Notes (optional)</label>
        <textarea className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything else…" />
      </div>

      <div className="flex items-center justify-end gap-2">
        <button onClick={() => submit.mutate()} disabled={submit.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-400 text-teal-950 text-sm font-semibold px-4 py-2 shadow-sm disabled:opacity-60">
          {submit.isPending ? <><Loader2 className="animate-spin" size={14} /> Submitting…</> : <>Submit <ArrowRight size={14} /></>}
        </button>
      </div>
      {submit.isError && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 text-red-900 text-sm px-3 py-2">
          <AlertCircle size={14} className="inline mr-1.5" />{String(submit.error)}
        </div>
      )}
    </div>
  );
}

function PickClient({ clients }: { clients: ApiClient[] }) {
  return (
    <div>
      <p className="text-sm text-ink-700 mb-3">
        Open the form via your client deeplink — pick the company you're submitting for:
      </p>
      <div className="grid sm:grid-cols-2 gap-2">
        {clients.map((c) => (
          <Link
            key={c.code}
            to={`/client/submit/${c.code}`}
            className="flex items-center justify-between gap-2 rounded-md border border-ink-200 px-3 py-2 hover:border-brand-300 hover:bg-brand-50/50 text-sm"
          >
            <span className="inline-flex items-center gap-2 min-w-0">
              <Building2 size={14} className="text-teal-700" />
              <span className="truncate">{c.name}</span>
            </span>
            <span className="text-2xs font-mono text-ink-500 shrink-0">{c.code}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── Email tab ─────────────────────────────────────────────── */

function EmailTab({ onResult }: { onResult: (r: { doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number }) => void }) {
  const [subject, setSubject] = useState("Timesheet for June 2026");
  const [from, setFrom] = useState("");
  const [body, setBody] = useState("");

  const submit = useMutation({
    mutationFn: () => api.submitEmail(body, subject, from, "client"),
    onSuccess: onResult,
  });

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="field-label">Subject</label>
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <label className="field-label">From (optional)</label>
          <input className="input" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="manager@yourco.com" />
        </div>
      </div>
      <div className="mb-3">
        <label className="field-label">Body</label>
        <textarea className="textarea font-mono text-xs" rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Carlos Smith - 22 days, 2 OT hours&#10;Ahmed Khan - 20 days, leave: AL" />
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={() => submit.mutate()} disabled={!body.trim() || submit.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-400 text-teal-950 text-sm font-semibold px-4 py-2 shadow-sm disabled:opacity-60">
          {submit.isPending ? <><Loader2 className="animate-spin" size={14} /> Submitting…</> : <>Submit <ArrowRight size={14} /></>}
        </button>
      </div>
    </div>
  );
}

/* ── Result card (shown after any submit) ─────────────────── */

function ResultCard({ result }: { result: { doc_id: string; timesheet_id: string; status: string; routing: string; confidence: number } }) {
  const auto = result.routing === "auto";
  return (
    <Panel
      title={auto ? "Submission processed — auto-invoice generated" : "Submission received — routed for review"}
      subtitle={`Reference: ${result.doc_id.slice(0, 8)}`}
      actions={
        <Link to="/client/invoices" className="btn-outline btn-sm">
          View my invoices <ArrowRight size={14} />
        </Link>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className={cn(
          "grid place-items-center h-12 w-12 rounded-full shrink-0",
          auto ? "bg-brand-100 text-brand-800" : "bg-amber-100 text-amber-800",
        )}>
          {auto ? <CheckCircle2 size={22} /> : <AlertCircle size={22} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink-700">
            Status: <strong>{result.status.replace(/_/g, " ")}</strong>
          </p>
          <div className="mt-1 flex items-center gap-2">
            <RoutingBadge routing={result.routing} />
            <ConfidenceBadge value={result.confidence} />
          </div>
          {!auto && (
            <p className="mt-2 text-xs text-ink-500">
              Our FinOps team will follow up shortly. No action needed from you unless we ask.
            </p>
          )}
          {auto && (
            <p className="mt-2 text-xs text-ink-500">
              Your tax invoice is ready. Click <Link to="/client/invoices" className="text-brand-700 font-medium">View my invoices <ReceiptText size={11} className="inline" /></Link> to review and approve.
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}
