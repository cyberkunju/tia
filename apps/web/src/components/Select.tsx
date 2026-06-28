import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib";

export type SelectOption = { value: string; label: string; disabled?: boolean };

type SelectProps = {
  value: string | null | undefined;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  /** "default" sits on a white surface; "band" sits on the orange command band. */
  variant?: "default" | "band";
  size?: "sm" | "md";
  align?: "left" | "right";
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  title?: string;
};

/**
 * Fully custom, accessible dropdown - replaces the native <select> so every
 * picker matches the TIA design language (brand focus ring, soft popover, a
 * brand check on the chosen row). Keyboard: ↑/↓ move, Enter/Space select,
 * Home/End jump, Esc close, type-to-find. Closes on outside click.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  variant = "default",
  size = "md",
  align = "left",
  disabled = false,
  className,
  ariaLabel,
  title,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const typeahead = useRef<{ buf: string; t: number | null }>({ buf: "", t: null });

  const selectedIndex = useMemo(() => options.findIndex((o) => o.value === value), [options, value]);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  useEffect(() => {
    if (open) setActive(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const commit = (idx: number) => {
    const o = options[idx];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    btnRef.current?.focus();
  };

  const move = (dir: 1 | -1) => {
    setActive((cur) => {
      let i = cur;
      for (let n = 0; n < options.length; n++) {
        i = (i + dir + options.length) % options.length;
        if (!options[i]?.disabled) return i;
      }
      return cur;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(1); break;
      case "ArrowUp": e.preventDefault(); move(-1); break;
      case "Home": e.preventDefault(); setActive(0); break;
      case "End": e.preventDefault(); setActive(options.length - 1); break;
      case "Enter":
      case " ": e.preventDefault(); commit(active); break;
      case "Escape": e.preventDefault(); setOpen(false); btnRef.current?.focus(); break;
      case "Tab": setOpen(false); break;
      default:
        if (e.key.length === 1) {
          const ta = typeahead.current;
          ta.buf += e.key.toLowerCase();
          if (ta.t) window.clearTimeout(ta.t);
          ta.t = window.setTimeout(() => { ta.buf = ""; }, 600);
          for (let n = 1; n <= options.length; n++) {
            const i = (active + n) % options.length;
            const o = options[i];
            if (o && !o.disabled && o.label.toLowerCase().startsWith(ta.buf)) { setActive(i); break; }
          }
        }
    }
  };

  const band = variant === "band";
  const triggerCls = band
    ? cn(
        "inline-flex w-full items-center justify-between gap-2 h-8 px-2.5 rounded-lg border text-[11px] font-medium",
        "bg-white/10 text-white border-white/20 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 transition-colors",
        open && "bg-white/20 ring-2 ring-white/30",
      )
    : cn(
        "inline-flex w-full items-center justify-between gap-2 rounded-md border bg-white text-ink-900 transition-shadow",
        "border-ink-300 hover:border-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm",
        open && "border-brand-500 ring-2 ring-brand-500/20",
        disabled && "opacity-50 pointer-events-none",
      );

  return (
    <div ref={rootRef} className={cn("relative inline-block text-left", className)}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={triggerCls}
      >
        <span className={cn("truncate", band && "max-w-[14rem]", !selected && (band ? "text-white/70" : "text-ink-400"))}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          size={band ? 14 : 16}
          className={cn("shrink-0 transition-transform duration-150", open && "rotate-180", band ? "text-white/80" : "text-ink-400")}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-activedescendant={`${baseId}-opt-${active}`}
          className={cn(
            "absolute z-50 mt-1.5 max-h-72 min-w-full w-max overflow-auto rounded-xl border border-ink-200 bg-white p-1 shadow-lg animate-fade-in",
            "max-w-[min(22rem,calc(100vw-2rem))]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {options.map((o, i) => {
            const isSel = o.value === value;
            const isActive = i === active;
            return (
              <li
                key={o.value}
                id={`${baseId}-opt-${i}`}
                data-idx={i}
                role="option"
                aria-selected={isSel}
                aria-disabled={o.disabled || undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm cursor-pointer select-none",
                  o.disabled && "opacity-40 pointer-events-none",
                  isActive && "bg-ink-100",
                  isSel ? "text-brand-700 font-medium" : "text-ink-700",
                )}
              >
                <Check size={14} className={cn("shrink-0", isSel ? "text-brand-600 opacity-100" : "opacity-0")} />
                <span className="truncate">{o.label}</span>
              </li>
            );
          })}
          {options.length === 0 && (
            <li className="px-2.5 py-2 text-sm text-ink-400 select-none">No options</li>
          )}
        </ul>
      )}
    </div>
  );
}
