/**
 * Revenue Leakage Sentinel — hero card on the Finance dashboard.
 *
 * "The silent cost of non-billing" — payroll lines that TASC paid but never
 * re-billed back to the client. Hits `GET /metrics/leakage` every 15s and
 * exposes a per-row Recover button that fires `POST /finance/leakage/{emp}/recover`
 * — issuing a catch-up invoice and chaining the audit event.
 */

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Shield, TrendingUp } from "lucide-react";
import { api } from "../api";
import { fmtAED } from "../lib";
import { Panel, EmptyState } from "../ui";
import type { LeakageEntry, LeakageReason } from "../types";

const REASON_LABEL: Record<LeakageReason, string> = {
  no_timesheet: "no timesheet",
  partial_timesheet: "partial bill",
  missing_overtime: "missing OT",
  rate_undercharge: "rate undercharge",
  late_period: "late period",
};

const REASON_TONE: Record<LeakageReason, string> = {
  no_timesheet: "bg-rose-100 text-rose-700 border-rose-200",
  partial_timesheet: "bg-amber-100 text-amber-700 border-amber-200",
  missing_overtime: "bg-amber-100 text-amber-700 border-amber-200",
  rate_undercharge: "bg-orange-100 text-orange-700 border-orange-200",
  late_period: "bg-violet-100 text-violet-700 border-violet-200",
};

function ReasonChip({ reason }: { reason: LeakageReason }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-2xs font-medium ${REASON_TONE[reason]}`}
    >
      {REASON_LABEL[reason]}
    </span>
  );
}

interface LeakageSentinelCardProps {
  /** Optional period override; defaults to the most recent in DB. */
  period?: string;
  /** Restrict to one client (passed in by Client persona contexts). */
  clientCode?: string;
}

export function LeakageSentinelCard({ period, clientCode }: LeakageSentinelCardProps) {
  const qc = useQueryClient();
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["metrics-leakage", period ?? "", clientCode ?? ""],
    queryFn: () => api.metricsLeakage(period, clientCode),
    refetchInterval: 15_000,
  });

  const recover = useMutation({
    mutationFn: (e: LeakageEntry) =>
      api.recoverLeakage(e.emp_id, data?.period ?? period ?? "June 2026", e.reason),
    onSuccess: () => qc.invalidateQueries(),
  });

  const stacked = useMemo(() => {
    if (!data) return [] as { client: string; segments: { reason: LeakageReason; amt: number }[]; total: number }[];
    return data.by_client.slice(0, 6).map((c) => {
      const segments = (Object.entries(c.by_reason) as [string, number][])
        .map(([reason, amt]) => ({ reason: reason as LeakageReason, amt }))
        .sort((a, b) => b.amt - a.amt);
      return { client: c.client_name || c.client_code, segments, total: c.total_aed };
    });
  }, [data]);

  return (
    <Panel
      title="Revenue leakage sentinel"
      subtitle="Associates on payroll without matching client billing — TIA agent can recover them."
    >
      {error ? (
        <div className="flex items-center gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">
          <AlertTriangle size={14} />
          Couldn't load leakage report: {(error as Error).message}
        </div>
      ) : isLoading || !data ? (
        <div className="flex items-center gap-2 text-sm text-ink-500">
          <Loader2 size={14} className="animate-spin" /> Scanning payroll…
        </div>
      ) : data.total_aed === 0 ? (
        <EmptyState
          title="No leakage detected"
          hint="Every associate on payroll has matching invoice coverage this period."
        />
      ) : (
        <div className="space-y-4">
          {/* Hero number + baseline delta */}
          <div className="flex items-baseline gap-3 flex-wrap">
            <div>
              <div className="text-3xl font-semibold tnum text-rose-700">
                {fmtAED(data.total_aed)}
              </div>
              <div className="text-2xs text-ink-500 mt-0.5">
                silently lost · {data.associate_count} associate
                {data.associate_count === 1 ? "" : "s"} · {data.period}
              </div>
            </div>
            {data.baseline_delta_pct != null && Number.isFinite(data.baseline_delta_pct) && (
              <span
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-2xs font-medium ${
                  data.is_anomalous_period
                    ? "bg-rose-100 text-rose-700 border-rose-200"
                    : "bg-ink-50 text-ink-600 border-ink-200"
                }`}
              >
                <TrendingUp size={10} />
                {data.baseline_delta_pct >= 0 ? "+" : ""}
                {(data.baseline_delta_pct * 100).toFixed(0)}% vs trailing baseline
              </span>
            )}
            {isFetching && (
              <span className="text-2xs text-ink-400 inline-flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" /> refreshing
              </span>
            )}
          </div>

          {/* Per-client stacked bars */}
          {stacked.length > 0 && (
            <div className="space-y-2.5">
              {stacked.map((row) => (
                <div key={row.client}>
                  <div className="flex items-center justify-between text-2xs text-ink-500 mb-1">
                    <span className="font-medium text-ink-700 truncate">{row.client}</span>
                    <span className="tnum">{fmtAED(row.total)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-ink-100 overflow-hidden flex">
                    {row.segments.map((seg, i) => (
                      <div
                        key={i}
                        className={`h-full ${
                          seg.reason === "no_timesheet"
                            ? "bg-rose-400"
                            : seg.reason === "partial_timesheet"
                              ? "bg-amber-400"
                              : seg.reason === "missing_overtime"
                                ? "bg-amber-300"
                                : seg.reason === "rate_undercharge"
                                  ? "bg-orange-400"
                                  : "bg-violet-400"
                        }`}
                        style={{ width: `${(seg.amt / row.total) * 100}%` }}
                        title={`${REASON_LABEL[seg.reason]}: ${fmtAED(seg.amt)}`}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Top 10 detail table */}
          <div>
            <div className="text-2xs uppercase tracking-wide text-ink-400 font-semibold mb-1.5">
              Top {data.entries.length} unbilled associates
            </div>
            <div className="divide-y divide-ink-100 border border-ink-200 rounded-lg overflow-hidden">
              {data.entries.map((e) => (
                <div
                  key={`${e.emp_id}-${e.reason}`}
                  className="flex items-center gap-3 py-2 px-3 text-sm hover:bg-ink-50/60 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-ink-800 truncate">{e.name}</div>
                    <div className="font-mono text-2xs text-ink-400">
                      {e.emp_id} · {e.client_name || e.client_code}
                    </div>
                  </div>
                  <ReasonChip reason={e.reason} />
                  <span className="tnum text-sm font-medium text-ink-900 shrink-0 w-24 text-right">
                    {fmtAED(e.expected_billable_aed)}
                  </span>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md border border-brand-200 bg-brand-50 px-2 py-1 text-2xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 transition-colors"
                    onClick={() => recover.mutate(e)}
                    disabled={recover.isPending}
                    title="Issue a catch-up recovery invoice for this associate"
                  >
                    {recover.isPending && recover.variables?.emp_id === e.emp_id ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Shield size={10} />
                    )}
                    Recover
                  </button>
                </div>
              ))}
            </div>
          </div>
          {recover.data && (
            <div className="text-2xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2">
              Recovery invoice <span className="font-mono">{recover.data.invoice_sequence_no}</span>{" "}
              issued · {fmtAED(recover.data.amount_aed)} · status {recover.data.status}.
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
