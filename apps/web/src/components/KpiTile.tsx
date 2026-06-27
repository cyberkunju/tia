import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib";

type Tone = "brand" | "teal" | "gold" | "red";

const TONE: Record<Tone, { bg: string; text: string; ring: string; accent: string }> = {
  brand: { bg: "bg-brand-50", text: "text-brand-900", ring: "ring-brand-200", accent: "text-brand-700" },
  teal:  { bg: "bg-teal-50",  text: "text-teal-900",  ring: "ring-teal-200",  accent: "text-teal-700"  },
  gold:  { bg: "bg-gold-50",  text: "text-gold-700",  ring: "ring-gold-200",  accent: "text-gold-700"  },
  red:   { bg: "bg-red-50",   text: "text-red-900",   ring: "ring-red-200",   accent: "text-red-700"   },
};

export function KpiTile({
  label, value, sub, target, hitTarget, icon: Icon, tone = "brand",
}: {
  label: string; value: ReactNode; sub?: ReactNode;
  target?: ReactNode; hitTarget?: boolean;
  icon?: LucideIcon; tone?: Tone;
}) {
  const t = TONE[tone];
  return (
    <div className={cn("rounded-xl p-5 ring-1 border border-transparent", t.bg, t.ring)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-500">{label}</div>
          <div className={cn("mt-1.5 text-3xl font-semibold tnum tracking-tight", t.text)}>{value}</div>
          {sub && <div className="mt-1 text-xs text-ink-600">{sub}</div>}
        </div>
        {Icon && (
          <span className={cn("grid place-items-center h-9 w-9 rounded-lg bg-white/70 shrink-0", t.accent)}>
            <Icon size={18} strokeWidth={2.25} />
          </span>
        )}
      </div>
      {target && (
        <div className="mt-3 flex items-center justify-between text-2xs">
          <span className="text-ink-500">Target {target}</span>
          {hitTarget !== undefined && (
            <span className={cn(
              "rounded px-1.5 py-0.5 font-semibold",
              hitTarget ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700",
            )}>{hitTarget ? "ON TARGET" : "BELOW"}</span>
          )}
        </div>
      )}
    </div>
  );
}
