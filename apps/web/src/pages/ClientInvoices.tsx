import { useQuery } from "@tanstack/react-query";
import { ReceiptText, ExternalLink } from "lucide-react";
import { api, API_BASE } from "../api";
import { fmtMoney } from "../lib";
import { PageHeader, StatusBadge, EmptyState, TableSkeleton } from "../ui";

export function ClientInvoices() {
  const { data, isLoading } = useQuery({
    queryKey: ["invoices"],
    queryFn: () => api.listInvoices(),
    refetchInterval: 4_000,
  });

  return (
    <div>
      <PageHeader
        icon={ReceiptText}
        title="Invoices"
        description="All generated invoices across clients."
      />

      <div className="card-flush">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Client</th>
                <th>Period</th>
                <th className="text-right">Amount</th>
                <th>Status</th>
                <th className="text-right">PDF</th>
              </tr>
            </thead>
            {isLoading ? (
              <TableSkeleton rows={5} cols={6} />
            ) : (
              <tbody>
                {data?.map((inv) => (
                  <tr key={inv.id}>
                    <td className="font-mono text-xs text-ink-500">{inv.id.slice(0, 8)}</td>
                    <td className="font-medium text-ink-800">{inv.client_code}</td>
                    <td className="text-ink-600">{inv.period ?? "—"}</td>
                    <td className="text-right font-medium tnum">{fmtMoney(inv.amount, inv.currency)}</td>
                    <td><StatusBadge status={inv.status} /></td>
                    <td className="text-right">
                      {inv.pdf_available ? (
                        <a
                          className="inline-flex items-center gap-1 text-brand-700 hover:text-brand-800 text-xs font-medium"
                          href={`${API_BASE}/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"
                        >
                          Open <ExternalLink size={12} />
                        </a>
                      ) : <span className="text-ink-300 text-xs">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>

        {!isLoading && (!data || data.length === 0) && (
          <EmptyState icon={ReceiptText} title="No invoices yet" hint="Approved timesheets generate invoices that appear here." />
        )}
      </div>
    </div>
  );
}
