import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { confidenceBadgeClass, fmtDate, fmtPct } from "../lib";

export function FinOpsTriage() {
  const { data, isLoading } = useQuery({
    queryKey: ["docs"],
    queryFn: api.listDocs,
    refetchInterval: 4_000,
  });

  const hitl = (data ?? []).filter((d) => d.status === "awaiting_review");

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Triage</h1>
      <p className="text-sm text-ink-600 mb-4">
        Documents waiting for human resolution — typically ambiguous entity matches (e.g. same name, same client, two Emp IDs).
      </p>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-600 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-2.5">Doc</th>
              <th className="text-left px-4 py-2.5">Channel</th>
              <th className="text-left px-4 py-2.5">Client</th>
              <th className="text-left px-4 py-2.5">Period</th>
              <th className="text-left px-4 py-2.5">Confidence</th>
              <th className="text-left px-4 py-2.5">Uploaded</th>
              <th className="text-right px-4 py-2.5">Resolve</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={7} className="py-6 text-center text-ink-400">Loading…</td></tr>}
            {!isLoading && hitl.length === 0 && (
              <tr><td colSpan={7} className="py-6 text-center text-ink-400">
                Nothing to triage. All docs auto-routed.
              </td></tr>
            )}
            {hitl.map((d) => (
              <tr key={d.doc_id} className="border-t border-ink-100 hover:bg-ink-50/60">
                <td className="px-4 py-3 font-mono text-xs">{d.doc_id.slice(0, 8)}</td>
                <td className="px-4 py-3"><span className="badge-slate">{d.channel}</span></td>
                <td className="px-4 py-3">{d.client_code ?? <span className="text-ink-400">—</span>}</td>
                <td className="px-4 py-3">{d.period ?? <span className="text-ink-400">—</span>}</td>
                <td className="px-4 py-3">
                  {d.confidence != null && <span className={confidenceBadgeClass(d.confidence)}>{fmtPct(d.confidence)}</span>}
                </td>
                <td className="px-4 py-3 text-ink-600">{fmtDate(d.uploaded_at)}</td>
                <td className="px-4 py-3 text-right">
                  <Link to={`/finops/review/${d.doc_id}`} className="btn-primary text-xs">Open →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
