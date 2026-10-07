/** CR-019 re-check: the web integer amount model (pure functions, no network). Run with tsx. */
const m = await import('../../../../apps/web/src/components/table/chip-amount.ts');
console.log(JSON.stringify({
  normalise_150_5: m.normaliseChipDraft('150.5'), parse_150_9: m.parseChipDraft('150.9'),
  clamp_150_5_in_20_1000: m.clampChips(150.5, 20, 1000), parse_empty: m.parseChipDraft(''), clamp_NaN: m.clampChips(Number.NaN, 20, 1000),
}));
