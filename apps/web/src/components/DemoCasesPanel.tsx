import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Loader2 } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { Panel, Badge } from "../ui";

/**
 * Demo cases — the 7 seeded fixtures the eval harness uses. Each is a real
 * timesheet shape from the brief; one click submits it through the pipeline
 * so judges can replay any scenario on stage.
 *
 * The case bodies live in the eval gold set; we POST each as an email body
 * to /intake/email — same as the portal email tab. Auto-detection routes by
 * content shape (no client_code hint).
 */
const CASES: { id: string; title: string; body: string; channel: "email" | "form"; expected: string }[] = [
  {
    id: "case_01",
    title: "Name-only timesheet (ambiguous client)",
    body: "Subject: Payout request\n\nClient: Majid Al Futtaim Retail LLC\nPeriod: June 2026\n\nFatima Khan - 23 days, total AED 12000\n\nRegards,\nOperations",
    channel: "email",
    expected: "HITL (Fatima Khan has duplicates)",
  },
  {
    id: "case_02",
    title: "From employee (Emp ID + days)",
    body: "Subject: My timesheet\n\nHi Payroll,\n\nMy employee id is EMP10001 and I worked 22 days this month with 2 OT hours.\n\nRegards,\nCarlos",
    channel: "email",
    expected: "Auto (single match)",
  },
  {
    id: "case_03",
    title: "Client roster (full month)",
    body: "Subject: Monthly timesheet\n\nClient: Emirates Steel Industries LLC\nPeriod: June 2026\n\nCarlos Smith - 22 days\nAhmed Khan - 20 days, 4 OT hours\nMeera Al Rashid - 21 days\n\nApproved by: Site Manager",
    channel: "email",
    expected: "Auto-dispatch (under threshold)",
  },
  {
    id: "case_06",
    title: "Leave + reimbursements",
    body: "Subject: Leave and reimbursements\n\nClient: Emirates Steel Industries LLC\nPeriod: June 2026\n\nEMP10001 Carlos Smith - 20 days, leave: AL, reimbursement AED 250 for taxi\nEMP10002 Ahmed Khan - 22 days, claim AED 120 for parking\n\nRegards,\nFinance",
    channel: "email",
    expected: "Auto (reimbursements parsed)",
  },
  {
    id: "case_13",
    title: "SOW already completed — R5 fail (mentor)",
    body: "Subject: June Hours\n\nClient: Etihad Engineering\nPeriod: June 2026\n\nRavi Menon - 40 hours on Deliverable Alpha (already 100% complete)\n\n— Site PM",
    channel: "email",
    expected: "HITL (R5 fails)",
  },
];

/** One-click replay panel for the seeded demo scenarios. */
export function DemoCasesPanel() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => {
      setBusy(id);
      return api.submitEmail(body, id, "demo@tia.test", "demo");
    },
    onSettled: () => { setBusy(null); qc.invalidateQueries({ queryKey: ["docs"] }); },
  });

  return (
    <Panel
      title="Demo cases (seeded)"
      subtitle="One-click replay of the 5 canonical scenarios — each submits through /intake/email."
    >
      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {CASES.map((c) => (
          <li key={c.id} className="rounded-md border border-ink-200 px-3 py-2.5 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="font-mono text-2xs text-ink-500">{c.id}</span>
                <Badge tone="slate" dot={false}>{c.channel}</Badge>
              </div>
              <p className="text-sm font-medium text-ink-900 truncate">{c.title}</p>
              <p className="text-2xs text-ink-500">Expected: {c.expected}</p>
            </div>
            <button
              className="btn-primary btn-sm shrink-0"
              disabled={busy === c.id}
              onClick={() => submit.mutate({ id: c.id, body: c.body })}
            >
              {busy === c.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Submit
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-2xs text-ink-400">
        These reflect the brief's 7 ambiguous-case design. Submit one, then watch it flow through the Pipeline stages.
      </p>
    </Panel>
  );
}
