/**
 * Claude review — the turn countdown on a player's seat depends on the
 * VIEWER'S wall clock. Renders the real SeatHud component (server-side, no
 * browser) for a turn that has 15 s left on the SERVER, with the viewer's
 * clock skewed by various amounts, and reads the countdown bar it draws.
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=review/claude/tsconfig.json node --import tsx review/claude/repro/seat-timer-skew.mjs
 */
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The component may compile with the classic JSX transform, which needs a React global.
globalThis.React = React;
const { SeatHud } = await import('../../../apps/web/src/components/table/seat-hud.tsx');

const TIME_BANK_MS = 15_000;
const serverNow = Date.now();
// What the server sends: an absolute deadline from ITS clock (turnEndsAt), plus a relative remaining time.
const turnEndsAt = new Date(serverNow + TIME_BANK_MS).toISOString();
const player = {
  seatIndex: 0, userId: 'hero', username: 'Hero', kind: 'HUMAN', botProfile: null, stack: 1000, committedThisStreet: 0,
  status: 'ACTIVE', isDealer: false, isSb: false, isBb: false, sittingOut: false, pendingLeave: false, waitingForBigBlind: false,
  holeCards: null, timeBankMsRemaining: TIME_BANK_MS, empty: false, avatarHue: 0,
};

function renderWithClockSkew(skewMs) {
  const realNow = Date.now;
  Date.now = () => realNow() + skewMs;
  try {
    return renderToStaticMarkup(createElement(SeatHud, { player, isHero: true, isToAct: true, isWinner: false, turnEndsAt, timeBankMs: TIME_BANK_MS, inHand: true }));
  } finally {
    Date.now = realNow;
  }
}

const rows = [];
for (const skewMs of [0, 5_000, 10_000, 14_000, -10_000, -60_000]) {
  const html = renderWithClockSkew(skewMs);
  const drain = /timebank-drain (\d+)ms/.exec(html)?.[1];
  const scale = /scaleX\(([\d.]+)\)/.exec(html)?.[1];
  rows.push({ viewerClockSkewSeconds: skewMs / 1000, serverSecondsLeft: TIME_BANK_MS / 1000, countdownShownSeconds: Number(drain) / 1000, barFullness: Number(scale) });
}
console.table(rows);
