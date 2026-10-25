import { expect, type Page } from "@playwright/test";

/** On a mobile viewport innerWidth grows with the content, so it cannot detect overflow; the visual viewport can. */
export async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = Math.ceil(window.visualViewport?.width ?? window.innerWidth);
    if (document.documentElement.scrollWidth <= width) return [];
    return [...document.querySelectorAll("body *")].flatMap((el) => {
      const right = Math.round(el.getBoundingClientRect().right);
      return right > width ? [`${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "").slice(0, 50)} right=${right} "${(el.textContent ?? "").trim().slice(0, 30)}"`] : [];
    }).slice(0, 5).concat([`viewport=${width}`]);
  });
  expect(overflow, "horizontal overflow").toEqual([]);
}

/** Visible links, buttons and fields matching the selector that are shorter than a 44 px tap target (checkboxes excluded). */
export async function smallTargets(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) => els.flatMap((el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width === 0 || style.visibility === "hidden" || style.display === "none" || (el as HTMLInputElement).type === "checkbox") return [];
    return box.height < 43.5 ? [`${el.tagName} "${(el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.height)}px`] : [];
  }));
}
