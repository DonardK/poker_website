/**
 * Recheck (legal-compliance group): server-side renders the real web
 * components (no browser, no network, no Next server) and checks the engine's
 * odd-chip order.
 *   CR-001: SiteFooter links, DraftBanner, AgeTermsGate unticked by default,
 *           every legal page renders with the draft banner and placeholders.
 *   CR-021: ConnectionStatus label for every "commitment" status spelling.
 *   CR-041: splitOddChips order versus the PotAward.oddChipSeatIndex comment.
 *
 * Usage (repository root):
 *   TSX_TSCONFIG_PATH=review/claude/tsconfig.json node --import tsx review/claude/recheck/legal-compliance/ssr-legal.mjs
 */
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

globalThis.React = React;
const web = '../../../../apps/web/src';
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---- CR-001 -----------------------------------------------------------------
const { SiteFooter } = await import(`${web}/components/site-footer.tsx`);
const footer = renderToStaticMarkup(createElement(SiteFooter));
console.log('[CR-001] footer hrefs:', [...footer.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).join(' '));
console.log('[CR-001] footer text:', text(footer).slice(-160));

const { AgeTermsGate, NO_CONSENT, hasConsent } = await import(`${web}/components/age-terms-gate.tsx`);
const gate = renderToStaticMarkup(createElement(AgeTermsGate, { value: NO_CONSENT, onChange: () => {} }));
console.log('[CR-001] gate checkboxes:', (gate.match(/type="checkbox"/g) ?? []).length, 'checked attrs:', (gate.match(/checked=""/g) ?? []).length,
  'hasConsent(NO_CONSENT)=', hasConsent(NO_CONSENT), 'hasConsent(age only)=', hasConsent({ confirmAge: true, acceptTerms: false }));

for (const page of ['terms', 'privacy', 'rules', 'fairness', 'responsible-gaming', 'complaints']) {
  try {
    const mod = await import(`${web}/app/${page}/page.tsx`);
    const html = renderToStaticMarkup(createElement(mod.default));
    const t = text(html);
    const placeholders = (html.match(/font-mono[^>]*>\[/g) ?? []).length;
    console.log(`[CR-001] /${page}: title="${mod.metadata?.title}" draft=${/Draft — pending legal review/.test(t)} version=${/Version 2026-10-01/.test(t)} placeholders=${placeholders} counselNotes=${(t.match(/For counsel review:/g) ?? []).length} chars=${t.length}`);
  } catch (err) {
    console.log(`[CR-001] /${page}: render failed: ${err?.message?.split('\n')[0]}`);
  }
}

// ---- CR-021 -----------------------------------------------------------------
const { ConnectionStatus, statusLabel } = await import(`${web}/components/table/connection-status.tsx`);
const { CARDS_MATCH_COMMITMENT } = await import(`${web}/hooks/use-table-socket.ts`).catch(() => ({ CARDS_MATCH_COMMITMENT: '(hook import failed)' }));
for (const status of [CARDS_MATCH_COMMITMENT, 'cards verified', 'live', 'verification failed']) {
  const html = renderToStaticMarkup(createElement(ConnectionStatus, { status }));
  console.log(`[CR-021] status "${status}" -> "${text(html)}" (statusLabel="${statusLabel(status)}") infoButton=${/About the card check/.test(html)}`);
}
const tablePage = readFileSync(new URL(`${web}/app/table/[id]/page.tsx`, import.meta.url), 'utf8');
console.log('[CR-021] table page still contains the literal "Cards verified":', /Cards verified/.test(tablePage));

// ---- CR-041 -----------------------------------------------------------------
const { splitOddChips } = await import('../../../../packages/engine/dist/index.js');
const shared = readFileSync(new URL('../../../../packages/shared/src/poker.ts', import.meta.url), 'utf8');
console.log('[CR-041] shared comment:', /earliest position past the blinds/.test(shared) ? 'OLD wording' : (shared.match(/Odd-chip rule:[^*]*\*[^*]*/)?.[0] ?? '?').replace(/\s+\*\s*/g, ' '));
for (const [dealer, winners] of [[0, [0, 3]], [2, [1, 4]], [5, [0, 5]]]) {
  const r = splitOddChips(winners.length * 10 + 1, winners, dealer, 6);
  console.log(`[CR-041] 6-max dealer=${dealer} winners=${winners} -> odd chip to seat ${r.oddChipSeatIndex} (first winner clockwise from seat ${(dealer + 1) % 6})`);
}
