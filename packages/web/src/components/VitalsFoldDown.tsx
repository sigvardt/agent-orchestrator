"use client";

import { useId, useState, type ReactNode } from "react";

interface VitalsFoldDownProps {
  title: string;
  count: number;
  accentClassName: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function VitalsFoldDown({
  title,
  count,
  accentClassName,
  defaultOpen = false,
  children,
}: VitalsFoldDownProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <section className="rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 px-3.5 py-3 text-left"
      >
        <svg
          className={`h-3 w-3 shrink-0 text-[var(--color-text-tertiary)] transition-transform ${
            open ? "rotate-90" : ""
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{title}</span>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${accentClassName}`}
        >
          {count}
        </span>
      </button>

      <div
        id={panelId}
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-[var(--color-border-subtle)] px-3.5 py-2.5">{children}</div>
        </div>
      </div>
    </section>
  );
}
