import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge, Play } from "lucide-react";
import { api } from "../api";
import { fmtPct, fmtMoney } from "../lib";
import { PageHeader, Panel, Metric, Badge, Spinner } from "../ui";

export function FinOpsEval() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["eval"], queryFn: api.evalSummary });
  const run = useMutation({ mutationFn: api.runEval, onSuccess: () => qc.invalidateQueries({ queryKey: ["eval"] }) });

  const allPass = data && data.passed === data.runnable;

  return (
    <div>
      <PageHeader
        icon={Gauge}
        title="Evaluation"
        description="Field-level F1 across every case. The CI gate blocks a >2% regression — this is the wrapper-killer."
        actions={
          <button className="btn-primary btn-sm" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? <><Spinner /> Running…</> : <><Play size={14} /> Run eval</>}
          </button>
        }
      />

      {isLoading && !data ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="card p-4 h-[88px]" />)}
        </div>
      ) : data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Metric label="Cases passed" value={<>{data.passed}<span className="text-ink-300">/{data.runnable}</span></>}
              hint={allPass ? "all green" : "attention needed"} accent={allPass} />
            <Metric label="Calibration error" value={data.ece.toFixed(3)} hint="ECE — lower is better" />
            <Metric label="F1 · days worked" value={data.macro_f1.days_worked?.toFixed(2) ?? "—"} />
            <Metric label="F1 · resolved" value={data.macro_f1.resolved?.toFixed(2) ?? "—"} />
          </div>

          <Panel title="Macro F1 per field" className="mb-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1">
              {Object.entries(data.macro_f1).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between border-b border-ink-100 py-1.5">
                  <span className="text-ink-500 font-mono text-xs">{k}</span>
                  <span className="font-medium tnum text-sm">{v.toFixed(3)}</span>
                </div>
              ))}
            </div>
          </Panel>

          <div className="card-flush">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Case</th><th>Input</th><th>Channel</th><th>Rows</th>
                    <th className="text-right">Invoice</th><th>Exceptions</th><th>Latency</th><th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r) => (
                    <tr key={r.case}>
                      <td className="font-semibold text-ink-800">#{r.case}</td>
                      <td className="text-xs text-ink-500">{r.input}</td>
                      <td><Badge tone="slate" dot={false}>{r.channel}</Badge></td>
                      <td className="tnum">{r.extracted_rows}<span className="text-ink-300">/{r.expected_rows}</span></td>
                      <td className="text-right tnum">{fmtMoney(r.invoice_amount)}</td>
                      <td className="tnum">{r.exceptions}</td>
                      <td className="tnum text-ink-500">{r.latency_s.toFixed(2)}s</td>
                      <td><Badge tone={r.passed ? "green" : "red"}>{r.passed ? "Pass" : "Fail"}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-ink-400 mt-3">
            Calibration error (ECE): {fmtPct(data.ece)}. Computed per row by binning confidence against row-correctness.
          </p>
        </>
      )}
    </div>
  );
}
