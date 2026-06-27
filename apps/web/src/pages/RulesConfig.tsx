import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib";
import { PageHeader, Panel, Badge, Spinner } from "../ui";

/**
 * Live rule catalogue — sourced from the backend `/rules` endpoint so chips on
 * Review screens, judges' demos, and this config page never drift apart.
 * Toggles are local for the demo; per-client persistence wires to the rule
 * engine next.
 */
export function RulesConfig() {
  const { data, isLoading } = useQuery({ queryKey: ["rules"], queryFn: api.listRules, staleTime: 60 * 60 * 1000 });
  const rules = useMemo(
    () => (data?.rules ?? []).map((r) => ({
      id: r.rule_id,
      name: r.function_name.replace(/^r\d+_/, "").replace(/_/g, " "),
      desc: r.friendly_message || "—",
    })),
    [data],
  );
  const [on, setOn] = useState<Record<string, boolean>>({});
  // First time data arrives, seed all-on.
  const initialised = useMemo(() => rules.every((r) => r.id in on), [rules, on]);
  if (!initialised && rules.length) setOn(Object.fromEntries(rules.map((r) => [r.id, true])));
  const enabled = Object.values(on).filter(Boolean).length;

  return (
    <div>
      <PageHeader
        icon={SlidersHorizontal}
        title="Validation rules"
        description="The deterministic BTP-style rule set every generated invoice is checked against. Failures route to human review."
        actions={data ? <Badge tone="brand">{enabled}/{data.count} enabled</Badge> : undefined}
      />
      <Panel bodyClassName="p-0">
        {isLoading ? (
          <div className="px-4 py-8 text-sm text-ink-500 flex items-center gap-2"><Spinner /> Loading rule catalogue…</div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-4 px-4 py-3">
                <button
                  onClick={() => setOn((s) => ({ ...s, [r.id]: !s[r.id] }))}
                  className={cn(
                    "relative h-5 w-9 rounded-full transition-colors shrink-0",
                    on[r.id] ? "bg-brand-600" : "bg-ink-300",
                  )}
                >
                  <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", on[r.id] ? "left-4" : "left-0.5")} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-2xs text-ink-500 bg-ink-100 px-1 rounded">{r.id}</span>
                    <span className="text-sm font-medium text-ink-900 capitalize">{r.name}</span>
                  </div>
                  <div className="text-xs text-ink-500 mt-0.5">{r.desc}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <p className="text-xs text-ink-400 mt-3">
        Rules execute deterministically server-side on every extraction path (Excel, email, GLM-OCR).
        Per-client profiles and persistence connect to the backend rule engine next.
      </p>
    </div>
  );
}
