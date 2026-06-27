import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { api } from "../api";
import { Panel } from "../ui";

/**
 * Tamper-evident audit chain integrity at a glance:
 *
 *   ✓ chain valid · 47 events · head: a7d23…
 *
 * If `/audit/verify` reports any hash_mismatch / prev_mismatch we render a red
 * banner naming the first few offenders.
 */
export function AuditChainCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["audit-verify"],
    queryFn: api.verifyAuditChain,
    refetchInterval: 30_000,
    retry: false,
  });

  const titleIcon = isError || data?.ok === false
    ? <ShieldAlert size={14} className="text-red-600" />
    : <ShieldCheck size={14} className="text-brand-600" />;

  return (
    <Panel
      title={<span className="flex items-center gap-2">{titleIcon} Audit chain integrity</span>}
      subtitle="Tamper-evident hash chain over every pipeline event."
    >
      {isLoading && (
        <div className="text-xs text-ink-500 inline-flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Verifying…
        </div>
      )}
      {!isLoading && isError && (
        <div className="text-xs rounded-md border border-red-200 bg-red-50 text-red-900 px-2.5 py-2">
          Could not reach /audit/verify.
        </div>
      )}
      {!isLoading && data && (
        data.ok ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              chain valid
            </span>
            <span className="text-ink-600">
              <strong className="tnum">{data.total}</strong> event{data.total === 1 ? "" : "s"}
            </span>
            {data.head && (
              <span className="text-ink-500">
                head <code className="font-mono text-2xs bg-ink-100 px-1 rounded">{data.head.slice(0, 8)}…</code>
              </span>
            )}
          </div>
        ) : (
          <div className="text-xs rounded-md border border-red-300 bg-red-50 text-red-900 px-2.5 py-2 space-y-1">
            <div className="font-semibold inline-flex items-center gap-1">
              <ShieldAlert size={12} /> chain BROKEN · {data.errors.length} integrity error{data.errors.length === 1 ? "" : "s"}
            </div>
            <ul className="text-2xs space-y-0.5 ml-4 list-disc">
              {data.errors.slice(0, 3).map((e) => (
                <li key={e.event_id}>
                  <code className="font-mono">{e.event_id.slice(0, 8)}…</code> · {e.kind}
                  {e.at && <span className="text-ink-500"> · {e.at.slice(0, 19).replace("T", " ")}</span>}
                </li>
              ))}
              {data.errors.length > 3 && (
                <li className="opacity-70">…and {data.errors.length - 3} more</li>
              )}
            </ul>
          </div>
        )
      )}
    </Panel>
  );
}
