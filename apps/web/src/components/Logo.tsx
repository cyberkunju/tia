import { cn } from "../lib";

/**
 * TIA wordmark. The T and A inherit `currentColor` (set the text colour in context);
 * the central stroke carries the TASC accent. Use `accent` to override that stroke
 * (e.g. "fill-white" on dark surfaces).
 */
export function Logo({ className, accent = "fill-brand-500" }: { className?: string; accent?: string }) {
  return (
    <svg viewBox="0 0 1680 769" fillRule="evenodd" role="img" aria-label="TIA"
         className={cn("w-auto block", className)}>
      <path className="fill-current" d="M0,0 631,0 631,177 426,177 426,767 236,767 236,177 0,177 Z" />
      <path className={accent} d="M676,0 862,0 862,557 739,767 675,767 Z" />
      <path className="fill-current" d="M1233,1 1287,90 1680,769 1052,769 1153,592 1367,591 1235,352 1232,352 1162,481 1001,767 792,768 791,765 815,723 Z" />
    </svg>
  );
}
