import { useQuery } from "@tanstack/react-query";
import { Mail, MessageCircle, Upload, FileEdit } from "lucide-react";
import { api } from "../api";
import { Panel } from "../ui";
import { cn } from "../lib";

type DotTone = "ok" | "warn" | "bad";

function tone(value: string | undefined | null): DotTone {
  if (!value) return "bad";
  if (value === "ok" || value === "configured" || value === "in_process") return "ok";
  if (typeof value === "string" && value.startsWith("missing")) return "warn";
  return "bad";
}
const DOT: Record<DotTone, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" };
const TEXT: Record<DotTone, string> = { ok: "text-emerald-700", warn: "text-amber-700", bad: "text-red-700" };

/**
 * IntakeChannelsPanel — every live way TIA accepts a timesheet. Shows real-time
 * health from /status (zoho_mail, etc.) and reminds the user that all four
 * channels feed the same pipeline.
 */
export function IntakeChannelsPanel() {
  const { data } = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: 15_000,
    retry: false,
  });

  const channels = [
    { id: "portal", icon: Upload, label: "Portal upload", health: "ok", note: "xlsx · csv · pdf · png · jpg · eml · txt" },
    { id: "email", icon: Mail, label: "Email inbox (Zoho IMAP)", health: data?.zoho_mail ?? "bad", note: data?.zoho_mail_address ?? "configured per client" },
    { id: "whatsapp", icon: MessageCircle, label: "WhatsApp (Meta Cloud API)", health: "ok", note: "voice notes + photos via AIDA loop" },
    { id: "form", icon: FileEdit, label: "Online form", health: "ok", note: "structured row-by-row input" },
  ];

  return (
    <Panel title="Intake channels" subtitle="Every live way TIA accepts a timesheet — all four feed the same pipeline.">
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {channels.map((c) => {
          const t = tone(c.health);
          return (
            <li key={c.id} className="flex items-start gap-2.5 rounded-md border border-ink-200 px-3 py-2">
              <span className="grid place-items-center h-8 w-8 rounded-md bg-ink-50 text-ink-600 shrink-0">
                <c.icon size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-ink-900 truncate">{c.label}</span>
                  <span className={cn("h-1.5 w-1.5 rounded-full", DOT[t])} />
                  <span className={cn("text-2xs uppercase font-semibold tracking-wide", TEXT[t])}>{c.health}</span>
                </div>
                <p className="text-2xs text-ink-500 truncate">{c.note}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-2xs text-ink-400">
        Zoho mailbox auto-polls every 60s. WhatsApp webhook lives at <code>/intake/whatsapp</code>. Online form auto-routes via <code>/submit/&lt;client&gt;</code>.
      </p>
    </Panel>
  );
}
