import { FileSpreadsheet, ExternalLink, Download } from "lucide-react";

/**
 * Inline source card for binary spreadsheets (xlsx/xls) - TextCard would
 * render the raw zip bytes ("PK..."), which looks broken on stage.
 * Instead show a clean "Excel workbook" placeholder with a download link;
 * the real, structured rows already appear in the Extracted column next to
 * this card.
 */
export function SpreadsheetCard({ sourceUrl, filename }: { sourceUrl: string; filename?: string }) {
  return (
    <div className="h-full overflow-hidden bg-white flex flex-col">
      <header className="border-b border-ink-200 bg-ink-50/50 px-5 py-3">
        <div className="flex items-center gap-2 text-2xs uppercase tracking-wide text-ink-500 font-semibold">
          <FileSpreadsheet size={12} className="text-emerald-700" />
          Spreadsheet
        </div>
        {filename && (
          <p className="mt-0.5 text-2xs font-mono text-ink-400 truncate">{filename}</p>
        )}
      </header>
      <div className="flex-1 grid place-items-center p-6">
        <div className="text-center max-w-sm">
          <div className="mx-auto h-14 w-14 grid place-items-center rounded-xl bg-emerald-50 ring-1 ring-emerald-100 mb-3">
            <FileSpreadsheet size={26} className="text-emerald-700" />
          </div>
          <p className="text-sm font-medium text-ink-800">Excel workbook</p>
          <p className="text-xs text-ink-500 mt-1">
            Parsed instantly via openpyxl. See the structured rows in the Extracted column.
          </p>
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="btn-outline btn-sm inline-flex mt-3">
            <Download size={12} /> Download original
            <ExternalLink size={11} />
          </a>
        </div>
      </div>
    </div>
  );
}
