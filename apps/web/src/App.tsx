import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AppShell } from "./AppShell";
import { ClientSubmit } from "./pages/ClientSubmit";
import { ClientInvoices } from "./pages/ClientInvoices";
import { FinOpsInbox } from "./pages/FinOpsInbox";
import { FinOpsReview } from "./pages/FinOpsReview";
import { FinOpsTriage } from "./pages/FinOpsTriage";
import { FinOpsDispatch } from "./pages/FinOpsDispatch";
import { FinOpsEval } from "./pages/FinOpsEval";
import { FinanceDashboard } from "./pages/FinanceDashboard";

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
      { path: "client/invoices", element: <ClientInvoices /> },
      { path: "finops", element: <FinOpsInbox /> },
      { path: "finops/review/:docId", element: <FinOpsReview /> },
      { path: "finops/triage", element: <FinOpsTriage /> },
      { path: "finops/dispatch", element: <FinOpsDispatch /> },
      { path: "finops/dispatch/:clientCode", element: <FinOpsDispatch /> },
      { path: "finops/eval", element: <FinOpsEval /> },
      { path: "finance", element: <FinanceDashboard /> },
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
