import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AppShell } from "./AppShell";
import { ClientSubmit } from "./pages/ClientSubmit";
import { ClientInvoices } from "./pages/ClientInvoices";
import { ClientQueries } from "./pages/ClientQueries";
import { FinOpsInbox } from "./pages/FinOpsInbox";
import { FinOpsReview } from "./pages/FinOpsReview";
import { FinOpsTriage } from "./pages/FinOpsTriage";
import { FinOpsDispatch } from "./pages/FinOpsDispatch";
import { FinOpsDispatchTracking } from "./pages/FinOpsDispatchTracking";
import { FinOpsEval } from "./pages/FinOpsEval";
import { FinOpsClients } from "./pages/FinOpsClients";
import { FinOpsClientForm } from "./pages/FinOpsClientForm";
import { FinanceDashboard } from "./pages/FinanceDashboard";
import { FinanceQueue } from "./pages/FinanceQueue";

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 2_000 } },
});

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/finops" replace /> },
      { path: "client/submit", element: <ClientSubmit /> },
      { path: "client/submit/:clientCode", element: <ClientSubmit /> },
      { path: "client/invoices", element: <ClientInvoices /> },
      { path: "client/queries", element: <ClientQueries /> },
      { path: "finops", element: <FinOpsInbox /> },
      { path: "finops/review/:docId", element: <FinOpsReview /> },
      { path: "finops/triage", element: <FinOpsTriage /> },
      { path: "finops/dispatch", element: <FinOpsDispatch /> },
      { path: "finops/dispatch/:clientCode", element: <FinOpsDispatch /> },
      { path: "finops/dispatch-tracking", element: <FinOpsDispatchTracking /> },
      { path: "finops/eval", element: <FinOpsEval /> },
      { path: "finops/clients", element: <FinOpsClients /> },
      { path: "finops/clients/new", element: <FinOpsClientForm /> },
      { path: "finops/clients/:code", element: <FinOpsClientForm /> },
      { path: "finance", element: <FinanceDashboard /> },
      { path: "finance/queue", element: <FinanceQueue /> },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
