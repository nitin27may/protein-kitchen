import type { SVGProps } from "react";

/** Small stroke icons. They inherit the text colour and are hidden from screen readers; pair them with a label. */
function base(props: SVGProps<SVGSVGElement>, d: string) {
  return (
    <svg viewBox="0 0 20 20" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      <path d={d} />
    </svg>
  );
}

export const CheckIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M4.5 10.5l3.5 3.5 7.5-8");
export const XIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M5 5l10 10M15 5L5 15");
export const PlusIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M10 4v12M4 10h12");
export const MinusIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M4 10h12");
export const SearchIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M9 15a6 6 0 100-12 6 6 0 000 12zM17 17l-3.8-3.8");
export const ChevronDownIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M5 8l5 5 5-5");
export const ChevronRightIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M8 5l5 5-5 5");
export const ArrowLeftIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M16 10H4M9 5l-5 5 5 5");
export const SlidersIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M4 6h7M15 6h1M4 14h1M9 14h7M11 4v4M7 12v4");
export const ThumbIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M7 9v7H4V9h3zm0 0l3-6c1.5 0 2 1 2 2v3h4a1 1 0 011 1.2l-1 5A1.5 1.5 0 0114.5 16H7");
