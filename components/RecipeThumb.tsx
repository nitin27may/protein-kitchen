import { MIN_COLLAGE_PHOTOS } from "@/lib/recipes/thumbs";

/**
 * Recipe photo, or a collage of its main ingredients when it has none (three or more photos, see `recipeThumbs`), or the
 * recipe's name on a plain card. One or two ingredient photos never stand in for a dish: a lone romaine leaf is not a falafel bowl.
 */
export function RecipeThumb({ image, thumbs, label, className = "" }: { image: string | null; thumbs: string[]; label: string; className?: string }) {
  const frame = `flex items-center justify-center overflow-hidden bg-primarysoft ${className}`;
  if (image) return <div className={frame}><img src={image} alt="" loading="lazy" className="size-full object-cover" /></div>;
  if (thumbs.length >= MIN_COLLAGE_PHOTOS) {
    const shown = thumbs.length === 3 ? thumbs : thumbs.slice(0, 4);
    return (
      <div className={`${frame} grid grid-cols-2 grid-rows-2 gap-px`} aria-hidden="true">
        {shown.map((f, i) => (
          <img key={f} src={f} alt="" loading="lazy" className={`size-full min-h-0 object-cover ${shown.length === 3 && i === 0 ? "row-span-2" : ""}`} />
        ))}
      </div>
    );
  }
  return <div className={`${frame} px-1 text-center text-xs font-semibold uppercase tracking-wide text-primary`}>{label}</div>;
}
