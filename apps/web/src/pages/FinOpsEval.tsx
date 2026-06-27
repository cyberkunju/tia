import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { fmtPct, fmtMoney } from "../lib";

export function FinOpsEval() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["eval"], queryFn: api.evalSummary });
  const run = useMutation({
    mutationFn: api.runEval,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["eval"] }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">Eval dashboard</h1>
          <p className="text-sm text-ink-600">
            Field-level F1 across all 7 cases · the CI gate fails on a {">"}2% regression.
            <span className="text-ink-400"> This is the wrapper-killer.</span>
          </p>
        </div>
        <button className="btn-primary" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Running…" : "Run eval"}
        </button>
      </div>

      {isLoading && <div className="text-ink-400">Loading…</div>}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Stat label="Cases passed" value={`${data.passed}/${data.runnable}`} hint="all 7 must pass" />
            <Stat label="ECE" value={data.ece.toFixed(3)} hint="expected calibration error" />
            <Stat label="F1 days_worked" value={data.macro_f1.days_worked?.toFixed(2) ?? "—"} />
            <Stat label="F1 resolved" value={data.macro_f1.resolved?.toFixed(2) ?? "—"} />
          </div>

          <div className="card p-4 mb-4">
            <h3 className="font-semibold mb-2">Macro F1 per field</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-sm">
              {Object.entries(data.macro_f1).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between border-b border-ink-100 py-1">
                  <span className="text-ink-600 font-mono text-xs">{k}</span>
                  <span className="font-medium tabular-nums">{v.toFixed(3)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-ink-600 text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-4 py-2.5">Case</th>
                  <th className="text-left px-4 py-2.5">Input</th>
                  <th className="text-left px-4 py-2.5">Channel</th>
                  <th className="text-left px-4 py-2.5">Rows</th>
                  <th className="text-left px-4 py-2.5">Invoice</th>
                  <th className="text-left px-4 py-2.5">Exceptions</th>
                  <th className="text-left px-4 py-2.5">Latency</th>
                  <th className="text-left px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((r) => (
                  <tr key={r.case} className="border-t border-ink-100">
                    <td className="px-4 py-3 font-medium">Case {r.case}</td>
                    <td className="px-4 py-3 text-xs text-ink-600">{r.input}</td>
                    <td className="px-4 py-3"><span className="badge-slate">{r.channel}</span></td>
                    <td className="px-4 py-3 tabular-nums">{r.extracted_rows}/{r.expected_rows}</td>
                    <td className="px-4 py-3 tabular-nums">{fmtMoney(r.invoice_amount)}</td>
                    <td className="px-4 py-3 tabular-nums">{r.exceptions}</td>
                    <td className="px-4 py-3 tabular-nums">{r.latency_s.toFixed(2)}s</td>
                    <td className="px-4 py-3">
                      <span className={r.passed ? "badge-green" : "badge-red"}>{r.passed ? "PASS" : "FAIL"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-ink-500 mt-3">
            Calibration error (ECE): {fmtPct(data.ece)}. Lower is better. Computed per-row by binning confidence vs row-correctness.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-ink-500 uppercase tracking-wider">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {hint && <div className="text-[10px] text-ink-400 mt-0.5">{hint}</div>}
    </div>
  );
}
