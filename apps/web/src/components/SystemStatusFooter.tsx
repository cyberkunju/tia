import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { cn } from "../lib";

type DotTone = "ok" | "warn" | "bad";

function classifyDot(value: string | undefined | null): DotTone {
  if (!value) return "bad";
  if (value === "ok" || value === "configured" || value === "in_process") return "ok";
  if (typeof value === "string" && value.startsWith("missing")) return "warn";
  return "bad";
}

const DOT_CLASS: Record<DotTone, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  bad: "bg-red-400",
};

const SERVICES: { key: "api" | "db" | "openai" | "modal_ocr" | "zoho_mail" | "rust_dispatch"; label: string; longLabel?: string }[] = [
  { key: "api", label: "api", longLabel: "FastAPI backend" },
  { key: "db", label: "db", longLabel: "Postgres" },
  { key: "openai", label: "openai", longLabel: "OpenAI (extraction + TIA chat)" },
  { key: "modal_ocr", label: "ocr", longLabel: "GLM-OCR on Modal · warm ≈2s · cold up to ≈90s for handwriting" },
  { key: "zoho_mail", label: "mail", longLabel: "Zoho IMAP mailbox poller" },
  { key: "rust_dispatch", label: "dispatch", longLabel: "Rust dispatch worker" },
];

/**
 * Compact six-dot service heartbeat. Polls /status every 15s. Hovering a dot
 * shows the raw status value (`configured` / `missing_key` / `ok` / `unreachable`
 * / etc.) so we can spot a misconfigured demo box on stage in seconds.
 *
 * Defaults to the white-on-brand-band styling used in the top header; set
 * `tone="dark"` for sidebar/footer contexts.
 */
export function SystemStatusFooter({ tone = "light", compact = false }: { tone?: "light" | "dark"; compact?: boolean } = {}) {
  const { data } = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: 15_000,
    retry: false,
  });

  const textCls = tone === "light" ? "text-white/85" : "text-teal-100";

  if (compact) {
    return (
      <div className={cn("flex items-center gap-1.5", textCls)}>
        {SERVICES.map((s) => {
          const raw = data?.[s.key] as string | undefined;
          const klass = DOT_CLASS[classifyDot(raw)];
          const title = `${s.longLabel ?? s.label}: ${raw ?? "—"}`;
          return (
            <span key={s.key} title={title} className={cn("h-1.5 w-1.5 rounded-full", klass)} />
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-1">
      {SERVICES.map((s) => {
        const raw = data?.[s.key] as string | undefined;
        const klass = DOT_CLASS[classifyDot(raw)];
        return (
          <span
            key={s.key}
            title={`${s.longLabel ?? s.label}: ${raw ?? "—"}`}
            className={cn("inline-flex items-center gap-1 text-2xs", textCls)}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", klass)} />
            {s.label}
          </span>
        );
      })}
    </div>
  );
}
