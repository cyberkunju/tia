import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Inbox, RefreshCw, ChevronRight } from "lucide-react";
import { api } from "../api";
import { fmtDate } from "../lib";
import {
  PageHeader, StatusBadge, RoutingBadge, ConfidenceBadge, Badge,
  EmptyState, TableSkeleton, Spinner,
} from "../ui";

export function FinOpsInbox() {
  const nav = useNavigate();
  const { data: docs, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["docs"],
    queryFn: api.listDocs,
    refetchInterval: 4_000,
  });

  return (
    <div>
      <PageHeader
        icon={Inbox}
        title="Inbox"
        description="Every ingested document across clients · live, refreshes every 4s"
        actions={
          <button className="btn-outline btn-sm" onClick={() => refetch()}>
            {isFetching ? <Spinner /> : <RefreshCw size={14} />} Refresh
          </button>
        }
      />

      <div className="card-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Client</th>
                <th>Period</th>
                <th>Status</th>
                <th>Routing</th>
                <th>Confidence</th>
                <th>Uploaded</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            {isLoading ? (
              <TableSkeleton rows={6} cols={8} />
            ) : (
              <tbody>
                {docs?.map((d) => (
                  <tr
                    key={d.doc_id}
                    className="row-link"
                    onClick={() => nav(`/finops/review/${d.doc_id}`)}
                  >
                    <td><Badge tone="slate" dot={false}>{d.channel}</Badge></td>
                    <td className="font-medium text-ink-800">{d.client_code ?? <span className="text-ink-400 font-normal">—</span>}</td>
                    <td className="text-ink-600">{d.period ?? <span className="text-ink-400">—</span>}</td>
                    <td><StatusBadge status={d.status} /></td>
                    <td><RoutingBadge routing={d.routing} /></td>
                    <td><ConfidenceBadge value={d.confidence} /></td>
                    <td className="text-ink-500 whitespace-nowrap">{fmtDate(d.uploaded_at)}</td>
                    <td className="text-right text-ink-300"><ChevronRight size={16} /></td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>

        {!isLoading && (!docs || docs.length === 0) && (
          <EmptyState
            icon={Inbox}
            title="No documents yet"
            hint="Submitted timesheets land here automatically as they're ingested."
            action={<Link to="/client/submit" className="btn-primary btn-sm">Submit a timesheet</Link>}
          />
        )}
      </div>
    </div>
  );
}
