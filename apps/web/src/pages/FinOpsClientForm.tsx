import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Building2, Save, Loader2, AlertCircle, ArrowLeft, FileText } from "lucide-react";
import { api } from "../api";
import { PageHeader, Panel, Badge } from "../ui";

const JURISDICTIONS = ["UAE", "KSA", "IN"];
const DISPATCH_ORDERS = [
  { v: "asc_by_amount", l: "Ascending by amount" },
  { v: "desc_by_amount", l: "Descending by amount" },
  { v: "asc_by_salary", l: "Ascending by salary" },
  { v: "desc_by_salary", l: "Descending by salary" },
  { v: "by_emp_id", l: "By employee ID" },
];
const GROUPING_MODES = [
  { v: "none", l: "No grouping (one packet per invoice)" },
  { v: "by_client_period", l: "Group by client + period (one packet)" },
];

interface Form {
  code: string; name: string; city: string; industry: string; contact_email: string;
  currency: string; jurisdiction: string; customer_trn: string; billing_entity: string;
  validation_threshold_aed: string;
  dispatch_order_rule: string;
  dispatch_grouping_mode: string;
  sla_days_to_invoice: string;
  payment_terms_days: string;
  watched_mailboxes: string;
  whatsapp_number: string;
}

const EMPTY: Form = {
  code: "", name: "", city: "", industry: "", contact_email: "",
  currency: "AED", jurisdiction: "UAE", customer_trn: "", billing_entity: "",
  validation_threshold_aed: "50000",
  dispatch_order_rule: "asc_by_amount",
  dispatch_grouping_mode: "by_client_period",
  sla_days_to_invoice: "5",
  payment_terms_days: "30",
  watched_mailboxes: "",
  whatsapp_number: "",
};

export function FinOpsClientForm() {
  const { code } = useParams<{ code?: string }>();
  const isEdit = !!code;
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data: clients } = useQuery({
    queryKey: ["clients"], queryFn: api.listClients, enabled: isEdit,
  });
  const existing = useMemo(() => clients?.find((c) => c.code === code), [clients, code]);

  const [form, setForm] = useState<Form>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (existing) {
      const s = existing.settings ?? {};
      setForm({
        code: existing.code,
        name: existing.name,
        city: existing.city ?? "",
        industry: existing.industry ?? "",
        contact_email: String(s.contact_email ?? ""),
        currency: String(s.currency ?? "AED"),
        jurisdiction: String(s.jurisdiction ?? "UAE"),
        customer_trn: String(s.customer_trn ?? ""),
        billing_entity: String(s.billing_entity ?? existing.name),
        validation_threshold_aed: String(s.validation_threshold_aed ?? 50000),
        dispatch_order_rule: String(s.dispatch_order_rule ?? "asc_by_amount"),
        dispatch_grouping_mode: String(s.dispatch_grouping_mode ?? "by_client_period"),
        sla_days_to_invoice: String(s.sla_days_to_invoice ?? 5),
        payment_terms_days: String(s.payment_terms_days ?? 30),
        watched_mailboxes: Array.isArray(s.watched_mailboxes) ? s.watched_mailboxes.join("\n") : "",
        whatsapp_number: String(s.whatsapp_number ?? ""),
      });
    }
  }, [existing]);

  const save = useMutation({
    mutationFn: async () => {
      const mailboxes = form.watched_mailboxes.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const payload = {
        code: form.code,
        name: form.name,
        city: form.city || undefined,
        industry: form.industry || undefined,
        contact_email: form.contact_email || undefined,
        currency: form.currency || "AED",
        jurisdiction: form.jurisdiction || "UAE",
        customer_trn: form.customer_trn || undefined,
        billing_entity: form.billing_entity || form.name,
        validation_threshold_aed: Number(form.validation_threshold_aed) || 50000,
        dispatch_order_rule: form.dispatch_order_rule,
        dispatch_grouping_mode: form.dispatch_grouping_mode,
        sla_days_to_invoice: Number(form.sla_days_to_invoice) || 5,
        payment_terms_days: Number(form.payment_terms_days) || 30,
        watched_mailboxes: mailboxes,
        whatsapp_number: form.whatsapp_number || undefined,
      };
      if (isEdit && existing) {
        return api.updateClientSettings(existing.code, payload);
      }
      return api.createClient(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      nav("/finops/clients");
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const set = (k: keyof Form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Building2}
        title={isEdit ? `Configure ${existing?.name ?? code}` : "Onboard a new client"}
        description={isEdit ? "Update channels, validation profile, dispatch rules." : "Brief §4.1 setup screen — onboards the client and configures its input channels + invoice dispatch rules."}
        actions={
          <button onClick={() => nav("/finops/clients")} className="btn-outline btn-sm">
            <ArrowLeft size={14} /> Back
          </button>
        }
      />

      <Panel title="Identity">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Client code" required>
            <input className="input font-mono" disabled={isEdit} value={form.code} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="CL011" />
          </Field>
          <Field label="Company name" required>
            <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Emirates Steel Industries LLC" />
          </Field>
          <Field label="City"><input className="input" value={form.city} onChange={(e) => set("city", e.target.value)} placeholder="Dubai" /></Field>
          <Field label="Industry"><input className="input" value={form.industry} onChange={(e) => set("industry", e.target.value)} placeholder="Manufacturing" /></Field>
          <Field label="Primary contact email"><input className="input" type="email" value={form.contact_email} onChange={(e) => set("contact_email", e.target.value)} placeholder="ap@client.com" /></Field>
          <Field label="Billing entity (on invoice)"><input className="input" value={form.billing_entity} onChange={(e) => set("billing_entity", e.target.value)} placeholder="Same as company name unless different" /></Field>
        </div>
      </Panel>

      <Panel title="Jurisdiction & tax">
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Jurisdiction" required>
            <select className="select" value={form.jurisdiction} onChange={(e) => set("jurisdiction", e.target.value)}>
              {JURISDICTIONS.map((j) => <option key={j} value={j}>{j}</option>)}
            </select>
          </Field>
          <Field label="Currency"><input className="input" value={form.currency} onChange={(e) => set("currency", e.target.value)} placeholder="AED" /></Field>
          <Field label="Customer TRN"><input className="input font-mono" value={form.customer_trn} onChange={(e) => set("customer_trn", e.target.value)} placeholder="100123456700003" /></Field>
        </div>
        <p className="mt-2 text-2xs text-ink-500">
          UAE 5% VAT · KSA 15% · India 18% GST (auto from contract). UAE Tax Invoice mandatory fields rendered from this.
        </p>
      </Panel>

      <Panel title="Validation profile (BTP-style)">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Threshold for Finance approval (AED)">
            <input className="input tnum" value={form.validation_threshold_aed} onChange={(e) => set("validation_threshold_aed", e.target.value)} placeholder="50000" />
          </Field>
          <Field label="Payment terms (days net)">
            <input className="input tnum" value={form.payment_terms_days} onChange={(e) => set("payment_terms_days", e.target.value)} placeholder="30" />
          </Field>
          <Field label="SLA — days to invoice after period close">
            <input className="input tnum" value={form.sla_days_to_invoice} onChange={(e) => set("sla_days_to_invoice", e.target.value)} placeholder="5" />
          </Field>
        </div>
        <p className="mt-2 text-2xs text-ink-500">
          Invoices over this threshold land in <Badge tone="amber">Finance approval queue</Badge> before dispatch. Per-contract parameters (max OT %, markup) live on the Contract; edit via the contracts API or a future contracts UI.
        </p>
      </Panel>

      <Panel title="Dispatch rules">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Order (within a client batch)">
            <select className="select" value={form.dispatch_order_rule} onChange={(e) => set("dispatch_order_rule", e.target.value)}>
              {DISPATCH_ORDERS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </Field>
          <Field label="Grouping">
            <select className="select" value={form.dispatch_grouping_mode} onChange={(e) => set("dispatch_grouping_mode", e.target.value)}>
              {GROUPING_MODES.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </Field>
        </div>
      </Panel>

      <Panel title="Input channels">
        <div className="grid gap-3">
          <Field label="Watched mailboxes (one per line)">
            <textarea className="textarea font-mono text-xs" rows={3} value={form.watched_mailboxes} onChange={(e) => set("watched_mailboxes", e.target.value)} placeholder={`timesheets-cl001@tia-watch.test\nbilling-cl001@tia-watch.test`} />
          </Field>
          <p className="text-2xs text-ink-500">
            TIA auto-routes any inbound mail to these addresses as <code className="text-2xs">watched_mailbox</code> intake for this client. Email modes <em>direct_forward</em> (TIA in <code>To</code>) and <em>cc_silent</em> (TIA in <code>Cc</code>) work regardless.
          </p>
          <Field label="WhatsApp number (optional)">
            <input className="input" value={form.whatsapp_number} onChange={(e) => set("whatsapp_number", e.target.value)} placeholder="+971501234567" />
          </Field>
        </div>
      </Panel>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 text-red-900 text-sm px-3 py-2 flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-3">
        {isEdit && existing && (
          <a
            href={`#${existing.code}`}
            onClick={(e) => { e.preventDefault(); document.querySelector<HTMLButtonElement>('button[aria-label="Open TIA chat"]')?.click(); }}
            className="text-xs text-brand-700 inline-flex items-center gap-1"
          >
            <FileText size={12} /> View Contract details via TIA chat
          </a>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => nav("/finops/clients")} className="btn-outline btn-sm">Cancel</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.code || !form.name}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 hover:bg-brand-400 text-teal-950 text-sm font-semibold px-4 py-2 shadow-sm disabled:opacity-60"
          >
            {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {isEdit ? "Save changes" : "Onboard client"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="field-label">
        {label}{required && <span className="text-red-600 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
