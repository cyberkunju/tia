import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { TriangleAlert, ChevronRight, CheckCircle2 } from "lucide-react";
import { api } from "../api";
import { fmtDate } from "../lib";
import {
  PageHeader, ConfidenceBadge, Badge, EmptyState, TableSkeleton,
} from "../ui";

export function FinOpsTriage() {
  const nav = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["docs"],
    queryFn: api.listDocs,
    refetchInterval: 4_000,
  });

  const hitl = (data ?? []).filter((d) => d.status === "awaiting_review");

  return (
    <div>
      <PageHeader
        icon={TriangleAlert}
        title="Triage"
        description="Documents awaiting human resolution — usually ambiguous entity matches (same name, same client, two Emp IDs)."
        actions={
          hitl.length > 0 ? <Badge tone="amber">{hitl.length} pending</Badge> : undefined
        }
      />

      <div className="card-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Channel</th>
                <th>Client</th>
                <th>Period</th>
                <th>Confidence</th>
                <th>Uploaded</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            {isLoading ? (
              <TableSkeleton rows={4} cols={7} />
            ) : (
              <tbody>
                {hitl.map((d) => (
                  <tr key={d.doc_id} className="row-link" onClick={() => nav(`/finops/review/${d.doc_id}`)}>
                    <td className="font-mono text-xs text-ink-500">{d.doc_id.slice(0, 8)}</td>
                    <td><Badge tone="slate" dot={false}>{d.channel}</Badge></td>
                    <td className="font-medium text-ink-800">{d.client_code ?? <span className="text-ink-400 font-normal">—</span>}</td>
                    <td className="text-ink-600">{d.period ?? <span className="text-ink-400">—</span>}</td>
                    <td><ConfidenceBadge value={d.confidence} /></td>
                    <td className="text-ink-500 whitespace-nowrap">{fmtDate(d.uploaded_at)}</td>
                    <td className="text-right text-ink-300"><ChevronRight size={16} /></td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>

        {!isLoading && hitl.length === 0 && (
          <EmptyState
            icon={CheckCircle2}
            title="Nothing to triage"
            hint="Every document has been auto-routed or already resolved."
            action={<Link to="/finops" className="btn-outline btn-sm">Back to inbox</Link>}
          />
        )}
      </div>
    </div>
  );
}
