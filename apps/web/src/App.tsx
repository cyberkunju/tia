import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AppShell } from "./AppShell";
import { Console } from "./pages/Console";
import { FinOpsDispatch } from "./pages/FinOpsDispatch";
import { FinOpsEval } from "./pages/FinOpsEval";
import { ClientsConfig } from "./pages/ClientsConfig";
import { RulesConfig } from "./pages/RulesConfig";
import { FinOpsDispatchTracking } from "./pages/FinOpsDispatchTracking";
import { FinOpsDispatchQueue } from "./pages/FinOpsDispatchQueue";
import { GlobalAuditLog } from "./pages/GlobalAuditLog";
import { ClientSubmit } from "./pages/ClientSubmit";
import { ClientInvoices } from "./pages/ClientInvoices";
import { ClientQueries } from "./pages/ClientQueries";
import { ClientStatement } from "./pages/ClientStatement";
import { FinanceDashboard } from "./pages/FinanceDashboard";
import { FinanceQueue } from "./pages/FinanceQueue";

import type { ReactNode } from "react";
import { SectionNav } from "./components/SectionNav";

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 2_000 } } });

// Fluid, centred container that fills the viewport at every size (no awkward gaps).
const Padded = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-8 pt-6 pb-24">
    <SectionNav />
    {children}
  </div>
);

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/console" replace /> },
      // FinOps — the pipeline console
      { path: "console", element: <Console /> },
      { path: "console/eval", element: <Padded><FinOpsEval /></Padded> },
      { path: "console/dispatch", element: <Padded><FinOpsDispatch /></Padded> },
      { path: "console/dispatch/tracking", element: <Padded><FinOpsDispatchTracking /></Padded> },
      { path: "console/dispatch/:clientCode", element: <Padded><FinOpsDispatchQueue /></Padded> },
      { path: "console/settings/clients", element: <Padded><ClientsConfig /></Padded> },
      { path: "console/settings/rules", element: <Padded><RulesConfig /></Padded> },
      { path: "console/audit", element: <Padded><GlobalAuditLog /></Padded> },
      // Client — portal
      { path: "portal", element: <Padded><ClientSubmit /></Padded> },
      { path: "portal/invoices", element: <Padded><ClientInvoices /></Padded> },
      { path: "portal/queries", element: <Padded><ClientQueries /></Padded> },
      { path: "portal/statement", element: <Padded><ClientStatement /></Padded> },
      // Finance — close
      { path: "finance", element: <Padded><FinanceDashboard /></Padded> },
      { path: "finance/queue", element: <Padded><FinanceQueue /></Padded> },
      // legacy redirects
      { path: "finops", element: <Navigate to="/console" replace /> },
      { path: "client/submit", element: <Navigate to="/portal" replace /> },
      { path: "client/invoices", element: <Navigate to="/portal/invoices" replace /> },
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
