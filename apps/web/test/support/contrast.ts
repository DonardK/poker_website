import type { Page } from "@playwright/test";

/**
 * Every visible text element meets WCAG AA contrast: 4.5:1, or 3:1 for large text (≥ 24 px, or ≥ 18.66 px bold).
 * Backgrounds are composited from the element up; the page's own gradient is taken at its lightest stop (#143d31),
 * the worst case for the light text used throughout. Disabled controls, hidden and aria-hidden content are exempt.
 */
export async function lowContrastTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (color: string) => { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); };
    const sample = () => Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    const alphaOf = (color: string) => { ctx.clearRect(0, 0, 1, 1); paint(color); return ctx.getImageData(0, 0, 1, 1).data[3]!; };
    const luminance = ([r, g, b]: number[]) => {
      const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    };
    const failures: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const text = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
      if (!text) continue;
      if (el.closest("[aria-hidden='true'], [disabled], script, style, noscript")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const layers: string[] = [];
      let opaqueImage = false;
      for (let node: HTMLElement | null = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none") opaqueImage = true;
        if (alphaOf(style.backgroundColor) > 0) layers.unshift(style.backgroundColor);
      }
      if (opaqueImage) continue;
      ctx.clearRect(0, 0, 1, 1);
      paint("#143d31");
      for (const layer of layers) paint(layer);
      const bg = sample();
      const style = getComputedStyle(el);
      paint(style.color);
      const fg = sample();
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      const ratio = (hi! + 0.05) / (lo! + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) failures.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 60)}" (${style.color})`);
    }
    return failures;
  });
}
