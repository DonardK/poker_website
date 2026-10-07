// Cross-check of contrast.mjs's oklch converter against the review's measured 3.19:1 for the old Call button
// (bg-emerald-600, text inherited from --ink #f4efe4). Pure computation.
import { readFileSync } from 'node:fs';
const theme = readFileSync('node_modules/tailwindcss/theme.css', 'utf8');
const m = /--color-emerald-600:\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/.exec(theme);
const [l, c, h] = [Number(m[1]) / 100, Number(m[2]), Number(m[3])];
const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180);
const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3, M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3, S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
const lin = [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S].map((v) => Math.min(1, Math.max(0, v)));
const Lbg = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
const ch = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const ink = [0xf4, 0xef, 0xe4];
const Link = 0.2126 * ch(ink[0]) + 0.7152 * ch(ink[1]) + 0.0722 * ch(ink[2]);
console.log('ink #f4efe4 on emerald-600:', ((Link + 0.05) / (Lbg + 0.05)).toFixed(2), '(review measured 3.19:1)');
