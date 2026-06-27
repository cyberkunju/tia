import { useQuery } from "@tanstack/react-query";
import { Mail, Loader2, FileWarning } from "lucide-react";

/** Inline .eml renderer - fetches the raw doc source, parses headers, renders email card. */
export function EmlCard({ sourceUrl }: { sourceUrl: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["eml", sourceUrl],
    queryFn: async (): Promise<string> => {
      const r = await fetch(sourceUrl);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.text();
    },
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-ink-400 text-sm">
        <Loader2 className="animate-spin mr-2" size={14} /> Loading email…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="h-full flex items-center justify-center text-ink-500 text-sm gap-1.5">
        <FileWarning size={14} /> Could not load source.
      </div>
    );
  }

  const parsed = parseEml(data);
  return (
    <div className="h-full overflow-auto bg-white">
      <header className="border-b border-ink-200 bg-ink-50/50 px-5 py-4">
        <div className="flex items-center gap-2 text-2xs uppercase tracking-wide text-ink-500 font-semibold mb-2">
          <Mail size={12} /> Email
        </div>
        <h3 className="text-base font-semibold text-ink-900 leading-tight">
          {parsed.subject || <span className="text-ink-400">(no subject)</span>}
        </h3>
        <div className="mt-2 space-y-0.5 text-xs">
          <KV label="From" value={parsed.from} />
          {parsed.to && <KV label="To" value={parsed.to} />}
          {parsed.cc && <KV label="Cc" value={parsed.cc} mono />}
          {parsed.date && <KV label="Date" value={parsed.date} />}
        </div>
      </header>
      <div className="px-5 py-4">
        <pre className="font-sans text-sm text-ink-800 leading-relaxed whitespace-pre-wrap break-words max-w-none">
          {parsed.body || <span className="text-ink-400">(empty body)</span>}
        </pre>
      </div>
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: string | undefined; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <span className="text-ink-500 font-medium w-14 shrink-0">{label}</span>
      <span className={`text-ink-700 ${mono ? "font-mono text-2xs" : ""}`}>{value}</span>
    </div>
  );
}

function parseEml(raw: string): { from?: string; to?: string; cc?: string; subject?: string; date?: string; body: string } {
  // Split on first blank line - RFC 2822 style. Our .eml files are simple text.
  const idx = raw.search(/\r?\n\r?\n/);
  const headerBlock = idx > -1 ? raw.slice(0, idx) : raw;
  const body = idx > -1 ? raw.slice(idx).replace(/^\r?\n\r?\n/, "") : "";
  const headers: Record<string, string> = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2].trim();
  }
  return {
    from: headers["from"],
    to: headers["to"],
    cc: headers["cc"],
    subject: headers["subject"],
    date: headers["date"],
    body,
  };
}
