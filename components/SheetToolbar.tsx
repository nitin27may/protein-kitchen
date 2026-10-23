"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const icon = "size-5 shrink-0";
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ExpandIcon = () => (
  <svg viewBox="0 0 24 24" className={icon} aria-hidden="true" {...stroke}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
);
const CompressIcon = () => (
  <svg viewBox="0 0 24 24" className={icon} aria-hidden="true" {...stroke}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
);
const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" className={icon} aria-hidden="true" {...stroke}><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14" /></svg>
);
const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" className="size-4 shrink-0" aria-hidden="true" {...stroke}><path d="m6 9 6 6 6-6" /></svg>
);
const InfoIcon = () => (
  <svg viewBox="0 0 24 24" className={icon} aria-hidden="true" {...stroke}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);
const SheetFileIcon = () => (
  <svg viewBox="0 0 24 24" className={icon} aria-hidden="true" {...stroke}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 9h16M4 15h16M10 3v18" /></svg>
);
const PdfFileIcon = () => (
  <svg viewBox="0 0 24 24" className={icon} aria-hidden="true" {...stroke}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 14h5M10 17.5h5" /></svg>
);

const btn = "inline-flex size-11 items-center lg:size-10 justify-center gap-0.5 rounded-control text-fg hover:bg-surface2 focus-visible:outline-2 focus-visible:outline-primary aria-expanded:bg-primarysoft aria-expanded:text-primary aria-pressed:bg-primarysoft aria-pressed:text-primary";

/** Closes a popover on outside click or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function Menu({ children, align = "right" }: { children: ReactNode; align?: "right" | "left" }) {
  return (
    <div role="menu" className={`absolute top-full z-30 mt-1 min-w-80 rounded-card border border-line bg-surface p-1 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}>
      {children}
    </div>
  );
}

export function SheetToolbar({ planId, full, onToggleFull }: { planId: number; full: boolean; onToggleFull: () => void }) {
  const dl = usePopover();
  const info = usePopover();
  const item = "flex w-full items-center gap-3 rounded-control px-3 py-2 text-left text-sm hover:bg-surface2";

  return (
    <div className="flex items-center gap-1 rounded-card border border-line bg-surface p-1" role="toolbar" aria-label="Sheet actions">
      <div ref={info.ref} className="relative">
        <button type="button" className={btn} aria-label="How this sheet works" title="How this sheet works" aria-expanded={info.open} aria-haspopup="true" onClick={() => info.setOpen(!info.open)}>
          <InfoIcon />
        </button>
        {info.open ? (
          <Menu>
            <ul className="space-y-1.5 p-3 text-sm text-muted">
              <li>Use the filter button on a header to sort or filter.</li>
              <li>Drag to select cells and copy with Ctrl+C.</li>
              <li>Switch sheets with the tabs at the bottom.</li>
              <li>Edits are not saved. The numbers come from the plan.</li>
            </ul>
          </Menu>
        ) : null}
      </div>

      <span aria-hidden="true" className="mx-0.5 h-6 w-px bg-line" />

      <button type="button" className={btn} aria-pressed={full} aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen" : "Full screen"} onClick={onToggleFull}>
        {full ? <CompressIcon /> : <ExpandIcon />}
      </button>

      <div ref={dl.ref} className="relative">
        <button type="button" className={`${btn} w-14`} aria-label="Download" title="Download" aria-haspopup="menu" aria-expanded={dl.open} onClick={() => dl.setOpen(!dl.open)}>
          <DownloadIcon />
          <ChevronIcon />
        </button>
        {dl.open ? (
          <Menu>
            <a role="menuitem" className={item} href={`/api/plan/${planId}/export?format=xlsx`} download onClick={() => dl.setOpen(false)}>
              <SheetFileIcon />
              <span><span className="block font-semibold">Excel workbook</span><span className="block text-xs text-muted">.xlsx, one sheet per week, totals, groceries</span></span>
            </a>
            <a role="menuitem" className={item} href={`/api/plan/${planId}/export?format=pdf`} download onClick={() => dl.setOpen(false)}>
              <PdfFileIcon />
              <span><span className="block font-semibold">PDF document</span><span className="block text-xs text-muted">.pdf, printable days and grocery list</span></span>
            </a>
          </Menu>
        ) : null}
      </div>
    </div>
  );
}
