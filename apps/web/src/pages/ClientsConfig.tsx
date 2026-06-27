import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, Plus, X } from "lucide-react";
import { api } from "../api";
import { cn, TASC_ENTITY } from "../lib";
import { PageHeader, Panel, Badge, Spinner, EmptyState } from "../ui";
import { Select } from "../components/Select";

const DISPATCH_RULES = [
  { id: "alphabetical", label: "Alphabetical by associate" },
  { id: "ascending_amount", label: "Ascending billable amount" },
  { id: "descending_amount", label: "Descending billable amount" },
  { id: "by_job_title", label: "Group by job title" },
];
const PROFILES = ["standard", "regulated", "lite"];

export function ClientsConfig() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data: clients, isLoading } = useQuery({ queryKey: ["clients"], queryFn: api.listClients });
  const active = params.get("c") ?? clients?.[0]?.code;
  const client = clients?.find((c) => c.code === active);
  const [showNew, setShowNew] = useState(false);

  const [rule, setRule] = useState("alphabetical");
  const [profile, setProfile] = useState("standard");
  const [markup, setMarkup] = useState(0.15);
  const [threshold, setThreshold] = useState(60000);

  useEffect(() => {
    const s = (client?.settings ?? {}) as Record<string, unknown>;
    setRule((s.dispatch_rule as string) ?? (s.dispatch_order_rule as string) ?? "alphabetical");
    setProfile((s.validation_profile as string) ?? "standard");
    setMarkup((s.markup_pct as number) ?? 0.15);
    setThreshold((s.threshold_aed as number) ?? (s.validation_threshold_aed as number) ?? 60000);
  }, [client]);

  const save = useMutation({
    mutationFn: () => api.updateClientSettings(active!, { dispatch_rule: rule, validation_profile: profile, markup_pct: markup, threshold_aed: threshold }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["clients"] }),
  });

  return (
    <div>
      <PageHeader icon={Building2} title="Clients & master data"
        description="Per-client channels, dispatch rule, validation profile, and commercial parameters that drive the pipeline."
        actions={<button className="btn-primary btn-sm" onClick={() => setShowNew((v) => !v)}>{showNew ? <X size={14} /> : <Plus size={14} />} {showNew ? "Close" : "New client"}</button>} />

      {showNew && <NewClientForm onDone={(code) => { setShowNew(false); qc.invalidateQueries({ queryKey: ["clients"] }); const p = new URLSearchParams(params); p.set("c", code); setParams(p); }} />}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        <Panel title="Clients" bodyClassName="p-0">
          {isLoading && <div className="p-4 text-sm text-ink-500 flex items-center gap-2"><Spinner /> Loading…</div>}
          <ul className="max-h-[60vh] overflow-y-auto">
            {clients?.map((c) => (
              <li key={c.code}>
                <button onClick={() => { const p = new URLSearchParams(params); p.set("c", c.code); setParams(p); }}
                  className={cn("w-full text-left px-4 py-2.5 border-b border-ink-100 hover:bg-ink-50", active === c.code && "bg-brand-50")}>
                  <div className="text-sm font-medium text-ink-900">{c.code}</div>
                  <div className="text-2xs text-ink-500 truncate">{c.name}</div>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        {client ? (
          <div className="space-y-4">
            <Panel title={client.name} subtitle={`${client.code} · ${client.city ?? "—"} · ${client.industry ?? "—"}`}
              actions={<Badge tone="blue" dot={false}>{client.industry ?? "—"}</Badge>}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <Field label="Billing entity" value={TASC_ENTITY.name} />
                <Field label="TRN" value={TASC_ENTITY.trn} />
                <Field label="Currency" value="AED" />
                <Field label="City" value={client.city ?? "—"} />
              </div>
            </Panel>

            <Panel title="Input channels">
              <div className="flex flex-wrap gap-2">{["Email", "Portal upload", "WhatsApp"].map((ch) => <Badge key={ch} tone="blue" dot={false}>{ch}</Badge>)}</div>
              <p className="text-xs text-ink-400 mt-2">Email + portal are live; WhatsApp via the Meta Cloud API bridge.</p>
            </Panel>

            <Panel title="Processing parameters" actions={<button className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Check size={14} />} Save</button>}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className="field-label">Dispatch rule</label><Select value={rule} onChange={setRule} options={DISPATCH_RULES.map((r) => ({ value: r.id, label: r.label }))} ariaLabel="Dispatch rule" /></div>
                <div><label className="field-label">Validation profile</label><Select value={profile} onChange={setProfile} options={PROFILES.map((p) => ({ value: p, label: p }))} ariaLabel="Validation profile" /></div>
                <div><label className="field-label">Management markup (%)</label><input className="input tnum" type="number" step="0.01" value={markup} onChange={(e) => setMarkup(parseFloat(e.target.value))} /></div>
                <div><label className="field-label">Finance approval threshold (AED)</label><input className="input tnum" type="number" step="1000" value={threshold} onChange={(e) => setThreshold(parseFloat(e.target.value))} /></div>
              </div>
            </Panel>
          </div>
        ) : <EmptyState icon={Building2} title="Select a client" />}
      </div>
    </div>
  );
}

function NewClientForm({ onDone }: { onDone: (code: string) => void }) {
  const [f, setF] = useState({ code: "", name: "", city: "", industry: "", customer_trn: "", validation_threshold_aed: 60000, dispatch_order_rule: "alphabetical" });
  const create = useMutation({ mutationFn: () => api.createClient(f), onSuccess: (r) => onDone(r.code) });
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Panel title="Onboard a client" className="mb-4"
      actions={<button className="btn-primary btn-sm" disabled={!f.code || !f.name || create.isPending} onClick={() => create.mutate()}>{create.isPending ? <Spinner /> : <Check size={14} />} Create</button>}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div><label className="field-label">Client code</label><input className="input" placeholder="CL011" value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} /></div>
        <div className="md:col-span-2"><label className="field-label">Name</label><input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
        <div><label className="field-label">City</label><input className="input" value={f.city} onChange={(e) => set("city", e.target.value)} /></div>
        <div><label className="field-label">Industry</label><input className="input" value={f.industry} onChange={(e) => set("industry", e.target.value)} /></div>
        <div><label className="field-label">Customer TRN</label><input className="input" value={f.customer_trn} onChange={(e) => set("customer_trn", e.target.value)} /></div>
      </div>
      {create.isError && <p className="text-xs text-red-600 mt-2">Could not create client (code may already exist).</p>}
    </Panel>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><div className="eyebrow">{label}</div><div className="text-ink-800 mt-0.5 truncate">{value}</div></div>;
}
