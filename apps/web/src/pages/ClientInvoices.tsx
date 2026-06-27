import { useQuery } from "@tanstack/react-query";
import { api, API_BASE } from "../api";
import { fmtMoney, statusBadgeClass } from "../lib";

export function ClientInvoices() {
  const { data, isLoading } = useQuery({
    queryKey: ["invoices"],
    queryFn: () => api.listInvoices(),
    refetchInterval: 4_000,
  });

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Invoices</h1>
      <p className="text-sm text-ink-600 mb-4">All generated invoices across all clients (mock client view).</p>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-ink-600 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-2.5">Invoice</th>
              <th className="text-left px-4 py-2.5">Client</th>
              <th className="text-left px-4 py-2.5">Period</th>
              <th className="text-right px-4 py-2.5">Amount</th>
              <th className="text-left px-4 py-2.5">Status</th>
              <th className="text-right px-4 py-2.5">PDF</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={6} className="py-6 text-center text-ink-400">Loading…</td></tr>}
            {!isLoading && (!data || data.length === 0) && (
              <tr><td colSpan={6} className="py-6 text-center text-ink-400">No invoices yet.</td></tr>
            )}
            {data?.map((inv) => (
              <tr key={inv.id} className="border-t border-ink-100">
                <td className="px-4 py-3 font-mono text-xs">{inv.id.slice(0, 8)}</td>
                <td className="px-4 py-3">{inv.client_code}</td>
                <td className="px-4 py-3">{inv.period ?? "—"}</td>
                <td className="px-4 py-3 text-right font-medium">{fmtMoney(inv.amount, inv.currency)}</td>
                <td className="px-4 py-3"><span className={statusBadgeClass(inv.status)}>{inv.status}</span></td>
                <td className="px-4 py-3 text-right">
                  {inv.pdf_available ? (
                    <a className="text-brand-700 hover:underline text-xs"
                       href={`${API_BASE}/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">Open PDF</a>
                  ) : <span className="text-ink-400 text-xs">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
