import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, X, Loader2, Inbox } from "lucide-react";
import { api } from "../api";
import { usePersona } from "../store";
import { cn, fmtAge } from "../lib";

/** Top-bar notification bell — dropdown with persona-scoped notifications. */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const { persona, currentClientCode } = usePersona();

  const { data, isLoading } = useQuery({
    queryKey: ["notifications", persona, currentClientCode],
    queryFn: () => api.notifications(persona, currentClientCode ?? undefined, 20),
    refetchInterval: 30_000,
    retry: false,
  });

  const unread = useMemo(() => (data ?? []).filter((n) => !n.read).length, [data]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        className="hidden md:inline-flex items-center justify-center h-8 w-8 rounded-lg border border-white/20 bg-white/10 text-white hover:bg-white/20 relative"
        title="Notifications"
      >
        <Bell size={14} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid place-items-center min-w-[14px] h-3.5 px-1 rounded-full bg-red-500 text-white text-[8px] font-bold ring-2 ring-brand-700">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-40 w-[min(90vw,360px)] max-h-[60vh] overflow-y-auto rounded-lg bg-white border border-ink-200 shadow-lg">
            <header className="sticky top-0 bg-white border-b border-ink-100 px-3 py-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-ink-800">
                <Bell size={13} /> Notifications
                <span className="text-2xs text-ink-400 font-normal">· {persona}{currentClientCode ? ` · ${currentClientCode}` : ""}</span>
              </div>
              <button className="btn-ghost btn-sm" onClick={() => setOpen(false)}><X size={12} /></button>
            </header>
            <div>
              {isLoading && (
                <div className="px-3 py-6 text-center text-xs text-ink-500 inline-flex items-center gap-1.5 w-full justify-center">
                  <Loader2 size={12} className="animate-spin" /> Loading…
                </div>
              )}
              {!isLoading && (!data || data.length === 0) && (
                <div className="px-3 py-6 text-center text-xs text-ink-400 flex flex-col items-center gap-1.5">
                  <Inbox size={20} className="text-ink-300" /> No notifications.
                </div>
              )}
              {data && data.length > 0 && (
                <ul className="divide-y divide-ink-100">
                  {data.map((n) => (
                    <li key={n.id} className={cn("px-3 py-2", !n.read && "bg-brand-50/40")}>
                      <div className="flex items-center gap-2 text-2xs text-ink-500 mb-0.5">
                        <span className="font-mono">{n.action}</span>
                        {n.at && <span className="ml-auto">{fmtAge(n.at)} ago</span>}
                      </div>
                      <p className="text-xs text-ink-800 leading-snug">{n.summary}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
