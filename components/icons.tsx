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

export const LeafIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M4 16C4 8 9 4 16 4c0 7-4 12-12 12zM4 16l7-7");
export const FruitIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M10 6C7 4 3 6 3 11s3 7 5 7c1 0 1-.5 2-.5s1 .5 2 .5c2 0 5-2 5-7s-4-7-7-5zM10 6c0-1.5.5-3 2-3.5");
export const WheatIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M10 18V6M10 8C8 8 6.5 6.5 6.5 4.5 8.5 4.5 10 6 10 8zM10 8c2 0 3.5-1.5 3.5-3.5C11.5 4.5 10 6 10 8zM10 13c-2 0-3.5-1.5-3.5-3.5 2 0 3.5 1.5 3.5 3.5zM10 13c2 0 3.5-1.5 3.5-3.5-2 0-3.5 1.5-3.5 3.5z");
export const BeanIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M5 7c2-4 8-4 10 0s0 9-5 9-7-5-5-9zM8 9c1 .5 2 1.5 2 3");
export const NutIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M10 3c3 2 5 5 5 8a5 5 0 01-10 0c0-3 2-6 5-8zM10 3v13");
export const DropIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M10 3s5 5.5 5 9a5 5 0 01-10 0c0-3.5 5-9 5-9z");
export const MilkIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M7 3h6v3l2 3v8H5V9l2-3V3zM5 11h10");
export const JarIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M6 4h8v2H6zM5 6h10v11H5zM8 10h4");
export const FlameIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M10 3c1 3 4 5 4 9a4 4 0 01-8 0c0-2 1-3 2-4 0 1 1 2 2 2 0-3-1-4 0-7z");
export const BlockIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M3 8l7-3 7 3v6l-7 3-7-3zM3 8l7 3 7-3M10 11v6");
export const SackIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M7 3h6l1 3H6zM6 6c-2 3-3 6-3 8a3 3 0 003 3h8a3 3 0 003-3c0-2-1-5-3-8");
export const RaisinIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M10 4a6 6 0 100 12 6 6 0 000-12zM7 8c1 1 2 1 3 0s2-1 3 0M7 12c1 1 2 1 3 0s2-1 3 0");
export const CapsuleIcon = (p: SVGProps<SVGSVGElement>) => base(p, "M4.5 11.5l7-7a3 3 0 014 4l-7 7a3 3 0 01-4-4zM8 8l4 4");
