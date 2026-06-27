import { useQuery } from "@tanstack/react-query";
import { FileText, Loader2, FileWarning, FileEdit } from "lucide-react";

/** Plain-text source renderer — for online-form submissions, case_02, case_06,
 * any other text/plain document we ingest. */
export function TextCard({ sourceUrl, filename }: { sourceUrl: string; filename?: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["text", sourceUrl],
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
        <Loader2 className="animate-spin mr-2" size={14} /> Loading text…
      </div>
    );
  }
  if (isError || data === undefined) {
    return (
      <div className="h-full flex items-center justify-center text-ink-500 text-sm gap-1.5">
        <FileWarning size={14} /> Could not load source.
      </div>
    );
  }

  // Detect if it looks like a /submit/{client} online-form payload (we render those
  // with a "Client: …" / "Period: …" header). Surface that with an "Online form" badge.
  const isOnlineForm = /^Client:\s/m.test(data) && /^Period:\s/m.test(data);

  return (
    <div className="h-full overflow-auto bg-white">
      <header className="border-b border-ink-200 bg-ink-50/50 px-5 py-3">
        <div className="flex items-center gap-2 text-2xs uppercase tracking-wide text-ink-500 font-semibold">
          {isOnlineForm ? <FileEdit size={12} /> : <FileText size={12} />}
          {isOnlineForm ? "Online form submission" : "Plain text"}
        </div>
        {filename && (
          <p className="mt-0.5 text-2xs font-mono text-ink-400 truncate">{filename}</p>
        )}
      </header>
      <pre className="font-mono text-xs leading-relaxed text-ink-800 whitespace-pre-wrap break-words px-5 py-4">
        {data || <span className="text-ink-400 italic">(empty file)</span>}
      </pre>
    </div>
  );
}
