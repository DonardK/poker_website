/**
 * CR-025 recheck: WCAG 2.x contrast of the table page's text colours, computed
 * from Tailwind 4's theme tokens (node_modules/tailwindcss/theme.css, oklch)
 * and the hex colours in apps/web/src/app/globals.css. Pure computation: reads
 * two CSS files, no network, no browser.
 *
 * Alpha backgrounds (bg-black/60 etc.) are composited over the darkest and
 * lightest colours they can sit on (page gradient #143d31..#050d0a, felt
 * gradient #1b6f55..#092c24). For light text the lightest underlay is the
 * worst case.
 *
 * Usage: node review/claude/recheck/web-ui/contrast.mjs
 */
import { readFileSync } from 'node:fs';

const theme = readFileSync('node_modules/tailwindcss/theme.css', 'utf8');
const tokens = {};
for (const m of theme.matchAll(/--color-([a-z]+-\d+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)\)/g)) {
  tokens[m[1]] = { l: Number(m[2]) / 100, c: Number(m[3]), h: m[4] === 'none' ? 0 : Number(m[4]) };
}

function oklchToSrgb({ l, c, h }) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  const gamma = (v) => { const x = Math.min(1, Math.max(0, v)); return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055; };
  return lin.map((v) => gamma(v) * 255);
}
const hex = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const hexAlpha = (h) => { const s = h.replace('#', ''); return s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1; };

/** "emerald-950", "white", "black", "#0b2a20", optionally "/60" alpha. */
function color(spec) {
  const [name, alphaPart] = spec.split('/');
  const alpha = alphaPart ? Number(alphaPart) / 100 : 1;
  let rgb;
  let a = alpha;
  if (name === 'white') rgb = [255, 255, 255];
  else if (name === 'black') rgb = [0, 0, 0];
  else if (name.startsWith('#')) { rgb = hex(name); a = alpha * hexAlpha(name); }
  else if (tokens[name]) rgb = oklchToSrgb(tokens[name]);
  else throw new Error(`unknown colour ${spec}`);
  return { rgb, a };
}
const over = (top, bottom) => top.rgb.map((v, i) => v * top.a + bottom[i] * (1 - top.a));
const lum = ([r, g, b]) => {
  const ch = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

/** Composite a chain of layers (bottom first) and the text colour; return the contrast. */
function contrast(text, layers) {
  let bg = color(layers[0]).rgb;
  for (const layer of layers.slice(1)) bg = over(color(layer), bg);
  const fg = over(color(text), bg);
  return ratio(fg, bg);
}

const PAGE_LIGHT = '#143d31';
const FELT_LIGHT = '#1b6f55';
const FELT_MID = '#0f4d3b';

// [where (file:line), text, size class, text colour, background chain (bottom first)]
const cases = [
  ['seat-hud.tsx:39 "Open seat" (xs)', 'emerald-100', ['emerald-950']],
  ['seat-hud.tsx:39 "Sit here" (xs semibold)', 'amber-100', ['emerald-950']],
  ['action-bar.tsx:146 Fold', 'white', ['zinc-700']],
  ['action-bar.tsx:146 Fold :hover', 'white', ['zinc-600']],
  ['action-bar.tsx:154 Check', 'white', ['emerald-700']],
  ['action-bar.tsx:154 Check :hover', 'white', ['emerald-800']],
  ['action-bar.tsx:161 Call', 'white', ['emerald-800']],
  ['action-bar.tsx:161 Call :hover', 'white', ['emerald-900']],
  ['action-bar.tsx:171 Raise', 'emerald-950', ['amber-300']],
  ['action-bar.tsx:171 Raise :hover', 'emerald-950', ['amber-200']],
  ['action-bar.tsx:179 All-in', 'white', ['red-700']],
  ['action-bar.tsx:179 All-in :hover', 'white', ['red-800']],
  ['action-bar.tsx:122 header text-amber-50 (xs) over page', 'amber-50', [PAGE_LIGHT, 'black/70']],
  ['action-bar.tsx:124 "Your turn" amber-200 (xs) over felt (phone dock)', 'amber-200', [FELT_LIGHT, 'black/70']],
  ['action-bar.tsx:128 countdown amber-100 on emerald-950', 'amber-100', ['emerald-950']],
  ['action-bar.tsx:128 countdown red-100 on red-950', 'red-100', ['red-950']],
  ['action-bar.tsx:128 countdown sky-100 on sky-950', 'sky-100', ['sky-950']],
  ['seat-hud.tsx:74 stack emerald-200 (xs) on black/60 over light felt', 'emerald-200', [FELT_LIGHT, 'black/60']],
  ['seat-hud.tsx:78 tags amber-200 (10px) on black/60 over light felt', 'amber-200', [FELT_LIGHT, 'black/60']],
  ['seat-hud.tsx:49 active seat (#17291fe8) tags amber-200 over light felt', 'amber-200', [FELT_LIGHT, '#17291fe8']],
  ['turn-clock.tsx:181 "To act" amber-100 (11px) on active seat over light felt', 'amber-100', [FELT_LIGHT, '#17291fe8']],
  ['turn-clock.tsx:181 urgent red-100 (11px) on active seat over light felt', 'red-100', [FELT_LIGHT, '#17291fe8']],
  ['turn-clock.tsx:181 bank sky-100 (11px) on active seat over light felt', 'sky-100', [FELT_LIGHT, '#17291fe8']],
  ['seat-hud.tsx:101 bet amber-100 (xs) on amber-300/10 on black/60 over light felt', 'amber-100', [FELT_LIGHT, 'black/60', 'amber-300/10']],
  ['poker-felt.tsx:58 phase amber-50 (xs) on felt centre', 'amber-50', [FELT_LIGHT]],
  ['poker-felt.tsx:87 winners amber-100 (sm) on felt centre', 'amber-100', [FELT_LIGHT]],
  ['game-log.tsx:23 entries emerald-50 (sm) on black/40 over page', 'emerald-50', [PAGE_LIGHT, 'black/40']],
  ['game-log.tsx:17 heading amber-200 (xs) on black/40 over page', 'amber-200', [PAGE_LIGHT, 'black/40']],
  ['table/[id]/page.tsx:135 help emerald-50/90 (xs) on page', 'emerald-50/90', [PAGE_LIGHT]],
  ['table/[id]/page.tsx:128 Leave link amber-200 (sm) on page', 'amber-200', [PAGE_LIGHT]],
  ['table-controls.tsx:120 Leave red-100 (sm) on page', 'red-100', [PAGE_LIGHT]],
  ['table-controls.tsx:129 sit-out notice amber-50 on amber-950/80 over page', 'amber-50', [PAGE_LIGHT, 'amber-950/80']],
  ['buy-in-dialog.tsx:202 description emerald-50 on #0b2a20', 'emerald-50', ['#0b2a20']],
  ['buy-in-dialog.tsx:241 balance emerald-100 on black/30 over #0b2a20', 'emerald-100', ['#0b2a20', 'black/30']],
  ['buy-in-dialog.tsx:251 status amber-100 on #0b2a20', 'amber-100', ['#0b2a20']],
  ['buy-in-dialog.tsx:244 alert red-100 on red-950/60 over #0b2a20', 'red-100', ['#0b2a20', 'red-950/60']],
  ['buy-in-dialog.tsx:260 Confirm emerald-950 on amber-300', 'emerald-950', ['amber-300']],
  ['fairness-audit.tsx:86 result red-200 (xs) on black/25 over #0b2a20', 'red-200', ['#0b2a20', 'black/25']],
  ['playing-card red #b62034 on #f2eee5', '#b62034', ['#f2eee5']],
];

const rows = cases.map(([where, text, layers]) => {
  const r = contrast(text, layers);
  return { where, text, background: layers.join(' > '), ratio: Number(r.toFixed(2)), passes45: r >= 4.5 };
});
console.table(rows);
const fails = rows.filter((r) => !r.passes45);
console.log(fails.length ? `${fails.length} pair(s) below 4.5:1` : 'every listed pair is at least 4.5:1');
// Sanity check of the converter against the review's measured value (Call button before the fix: 3.19:1).
console.log('sanity: white on emerald-600 =', contrast('white', ['emerald-600']).toFixed(2), '(the old Call colour per the review: 3.19:1 measured)');
