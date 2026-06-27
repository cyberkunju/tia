import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { confidenceBadgeClass, fmtDate, fmtPct, routingBadgeClass, statusBadgeClass } from "../lib";

export function FinOpsInbox() {
  const { data: docs, isLoading, refetch } = useQuery({
    queryKey: ["docs"],
    queryFn: api.listDocs,
    refetchInterval: 4_000,
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="text-sm text-ink-600">All ingested documents across clients · auto-refreshes every 4s</p>
        </div>
        <button className="btn-outline" onClick={() => refetch()}>Refresh</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-600 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-2.5">Channel</th>
              <th className="text-left px-4 py-2.5">Client</th>
              <th className="text-left px-4 py-2.5">Period</th>
              <th className="text-left px-4 py-2.5">Status</th>
              <th className="text-left px-4 py-2.5">Routing</th>
              <th className="text-left px-4 py-2.5">Confidence</th>
              <th className="text-left px-4 py-2.5">Uploaded</th>
              <th className="text-right px-4 py-2.5">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-ink-400">Loading…</td></tr>
            )}
            {!isLoading && (!docs || docs.length === 0) && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-ink-400">
                No documents yet. Upload one from <Link className="underline" to="/client/submit">Client → Submit</Link>.
              </td></tr>
            )}
            {docs?.map((d) => (
              <tr key={d.doc_id} className="border-t border-ink-100 hover:bg-ink-50/60">
                <td className="px-4 py-3"><span className="badge-slate">{d.channel}</span></td>
                <td className="px-4 py-3">{d.client_code ?? <span className="text-ink-400">—</span>}</td>
                <td className="px-4 py-3">{d.period ?? <span className="text-ink-400">—</span>}</td>
                <td className="px-4 py-3"><span className={statusBadgeClass(d.status)}>{d.status}</span></td>
                <td className="px-4 py-3">
                  {d.routing ? <span className={routingBadgeClass(d.routing)}>{d.routing}</span> : <span className="text-ink-400">—</span>}
                </td>
                <td className="px-4 py-3">
                  {d.confidence != null ? (
                    <span className={confidenceBadgeClass(d.confidence)}>{fmtPct(d.confidence)}</span>
                  ) : <span className="text-ink-400">—</span>}
                </td>
                <td className="px-4 py-3 text-ink-600">{fmtDate(d.uploaded_at)}</td>
                <td className="px-4 py-3 text-right">
                  <Link to={`/finops/review/${d.doc_id}`} className="text-brand-700 hover:underline font-medium">
                    Review →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
