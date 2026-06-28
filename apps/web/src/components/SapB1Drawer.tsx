/**
 * Collapsible drawer that shows the SAP Business One A/R Invoice OData v4
 * payload for one invoice. Lazy-fetches on expand. Has a Copy button so
 * integrators can paste it into Postman / curl against their B1 instance.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, Check, FileJson } from "lucide-react";
import { api } from "../api";

interface SapB1DrawerProps {
  invoiceId: string;
}

export function SapB1Drawer({ invoiceId }: SapB1DrawerProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["sap-b1", invoiceId],
    queryFn: () => api.sapB1Payload(invoiceId),
    enabled: open,
    staleTime: 60_000,
  });

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data.payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore clipboard failures */
    }
  };

  return (
    <div className="rounded-lg border border-ink-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-700 bg-ink-50 hover:bg-ink-100 transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <FileJson size={12} className="text-brand-500" />
        <span className="font-medium">SAP Business One payload</span>
        <span className="text-2xs text-ink-500 font-mono">POST /b1s/v2/Invoices</span>
      </button>
      {open && (
        <div className="bg-white px-3 py-2 border-t border-ink-200">
          {isLoading ? (
            <div className="text-2xs text-ink-500">Generating payload…</div>
          ) : error ? (
            <div className="text-2xs text-ink-600 bg-ink-50 border border-ink-200 rounded p-2">
              {/^.*\b404\b/.test((error as Error).message)
                ? "This invoice is no longer in the database — it may have been wiped by a demo-reset. Refresh the page to pick up the new invoice IDs."
                : `Couldn't generate the SAP payload: ${(error as Error).message.slice(0, 140)}`}
            </div>
          ) : data ? (
            <>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-2xs text-ink-500 font-mono">
                  {data.invoice_sequence_no ?? data.invoice_id}
                </span>
                <button
                  onClick={copy}
                  className="inline-flex items-center gap-1 rounded-md border border-ink-200 px-2 py-0.5 text-2xs text-ink-700 hover:bg-ink-50 transition-colors"
                >
                  {copied ? (
                    <>
                      <Check size={10} className="text-emerald-600" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy size={10} /> Copy JSON
                    </>
                  )}
                </button>
              </div>
              <pre className="max-h-[280px] overflow-auto rounded bg-ink-50/60 p-2 font-mono text-[10px] leading-relaxed text-ink-800">
                {JSON.stringify(data.payload, null, 2)}
              </pre>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
