// CR-025 recheck (gap search): the seat avatar initials are text-xs font-bold text-black on
// hsl(avatarHue 70% 60%) (apps/web/src/components/table/seat-hud.tsx:58-62). avatarHue is randomInt(360)
// at registration (apps/server/src/auth/routes.ts:183, :240). Pure computation, no I/O.
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
}
const lum = ([r, g, b]) => {
  const ch = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const failing = [];
let worst = { hue: -1, ratio: Infinity };
for (let hue = 0; hue < 360; hue++) {
  const ratio = (lum(hslToRgb(hue, 0.7, 0.6)) + 0.05) / 0.05; // text is black (luminance 0)
  if (ratio < 4.5) failing.push(hue);
  if (ratio < worst.ratio) worst = { hue, ratio };
}
const ranges = [];
for (const h of failing) {
  const last = ranges[ranges.length - 1];
  if (last && last[1] === h - 1) last[1] = h; else ranges.push([h, h]);
}
console.log(`black 12px bold initials on hsl(h 70% 60%): ${failing.length}/360 hues below 4.5:1`);
console.log('failing hue ranges:', ranges.map(([a, b]) => `${a}-${b}`).join(', ') || 'none');
console.log(`worst: hue ${worst.hue} at ${worst.ratio.toFixed(2)}:1`);
console.log(`share of randomInt(360) users affected: ${(100 * failing.length / 360).toFixed(1)}%`);
