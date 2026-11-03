// The wallet routes of poker-api (/api/wallet/*, docs/money/WALLET.md section 11.1; the bodies are
// packages/shared/src/wallet.ts) and the payments Worker's sandbox pages, in memory. Gates, reasons and
// error codes follow apps/edge/src/payments (gate.ts realMoneySummary, deposits.ts, instruments.ts,
// withdrawals.ts); step-up grants are the auth fixture's (consumeGrant), bound with the same stepUpBind
// the Worker uses. Money is BigInt minor units inside and a decimal string on the wire, as in the API.
// The default mode is "off" (production today), so specs that never touch the wallet see no change.
import { randomUUID } from 'node:crypto';
import {
  MONEY_AMOUNT_PATTERN, STEP_UP_METHODS_BY_PURPOSE, WALLET_ERROR_STATUS, WITHDRAWAL_DISPLAY_STATUS, payoutDestinationAction, stepUpBind, withdrawalAction,
} from '@poker/shared';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** apps/edge/src/http/wallet.ts OBJECT_ID and GRANT_ID. */
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PERIODS = ['DAY', 'WEEK', 'MONTH'];
const DAY_MS = 86_400_000;
/** Every crypto asset the sandbox rail knows. USDT is never offered to EEA residents (design-payments section 2.3). */
const CRYPTO_ASSETS = [
  { code: 'BTC', network: 'bitcoin', label: 'Bitcoin (BTC)', minConfirmations: 2, perEuro: '0.00001600' },
  { code: 'ETH', network: 'ethereum', label: 'Ether (ETH)', minConfirmations: 12, perEuro: '0.00040000' },
  { code: 'USDC_ERC20', network: 'ethereum', label: 'USD Coin (USDC)', minConfirmations: 12, perEuro: '1.08' },
  { code: 'USDT_TRC20', network: 'tron', label: 'Tether (USDT)', minConfirmations: 20, perEuro: '1.08' },
];
/** The deposit addresses the sandbox hands out (BIP-173, EIP-55 and TRON examples: on no chain the fixture controls). */
const DEPOSIT_ADDRESS = {
  bitcoin: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  ethereum: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  tron: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
};
const ADDRESS = {
  bitcoin: /^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[02-9ac-hj-np-z]{11,71}|BC1[02-9AC-HJ-NP-Z]{11,71})$/,
  ethereum: /^0x[0-9a-fA-F]{40}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};
const CARD_FEE = 0n;
const CRYPTO_FEE = 150n;

const iso = (ms) => new Date(ms).toISOString();
const now = () => Date.now();

function money(minor) {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
/** A request amount (MONEY_AMOUNT_PATTERN) as minor units, or null. Never through a float. */
function parseMinor(value) {
  if (typeof value !== 'string' || !MONEY_AMOUNT_PATTERN.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
/** crypto-address.ts normalizeCryptoAddress: what is stored and bound, and what the API shows. */
function normalizeAddress(network, raw) {
  const address = typeof raw === 'string' ? raw.trim() : '';
  const format = ADDRESS[network];
  if (!format || !format.test(address)) return null;
  if (network === 'ethereum') {
    // The Worker shows the EIP-55 checksum form; the fixture shows a mixed-case address as typed (no keccak here).
    const lower = `0x${address.slice(2).toLowerCase()}`;
    return { normalized: lower, display: address === address.toLowerCase() || address.slice(2) === address.slice(2).toUpperCase() ? lower : address };
  }
  if (network === 'bitcoin' && /^bc1/i.test(address)) return { normalized: address.toLowerCase(), display: address.toLowerCase() };
  return { normalized: address, display: address };
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#fff8e1;color:#1f1300;max-width:36rem;margin:2rem auto;padding:0 1rem}`
    + `button{font:inherit;padding:.75rem 1.25rem;margin:.25rem .5rem .25rem 0;border-radius:999px;border:2px solid #1f1300;background:#fff}`
    + `.note{border:2px dashed #8a5a00;padding:.75rem 1rem;border-radius:12px}</style></head><body>${body}</body></html>`;
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * @param {{ auth: ReturnType<typeof import('./auth-fixture.mjs').createAuthFixture>, origins: string[], fixtureOrigin: string }} input
 */
export function createWalletFixture({ auth, origins, fixtureOrigin }) {
  /** Deployment facts (PAYMENTS_MODE, switches, provider choice) and one-shot test behaviour. */
  let config;
  /** userId -> the payments side of one player (PlayerCompliance, balances, deposits, instruments, quotes, withdrawals). */
  const wallets = new Map();
  /** Every wallet request, with its Idempotency-Key, for specs that check what was sent. */
  let log = [];

  function reset() {
    config = {
      // 'absent': an API without the wallet routes (404); 'off' | 'sandbox' | 'live': PAYMENTS_MODE.
      mode: 'off',
      kycProvider: 'sandbox',
      kycBeforeDeposit: true,
      eea: true,
      methods: { deposit: ['CARD', 'CRYPTO'], withdraw: ['CARD', 'CRYPTO'] },
      paused: false,
      regionBlocked: false,
      allowCancel: false,
      coolingOffMs: DAY_MS,
      settleDelayMs: 1_200,
      kycDelayMs: 1_500,
      quoteTtlMs: 2 * 60_000,
      nextError: null,
      rejectNextGrant: false,
      tamperBind: null,
    };
    wallets.clear();
    log = [];
  }
  reset();
  auth.onReset(reset);

  function walletOf(account) {
    let wallet = wallets.get(account.id);
    if (!wallet) {
      wallet = {
        kyc: 'UNVERIFIED', kycSettle: null, limitsChosen: false, selfExcluded: false, restriction: 'NONE',
        limits: Object.fromEntries(PERIODS.map((p) => [p, { active: null, pending: null }])),
        available: 0n, held: 0n,
        deposits: new Map(), instruments: new Map(), quotes: new Map(), withdrawals: new Map(), txs: [], replies: new Map(), seq: 0,
      };
      wallets.set(account.id, wallet);
    }
    return wallet;
  }

  const asset = () => (config.mode === 'sandbox' ? 'TEST_EUR' : 'EUR');
  const cryptoOptions = () => CRYPTO_ASSETS.filter((a) => !(config.eea && a.code.startsWith('USDT')));
  const holdActive = (account) => account.securityHoldUntil !== null && Date.parse(account.securityHoldUntil) > now();

  function refuse(res, code, error, extra = {}) {
    res.status(WALLET_ERROR_STATUS[code] ?? 400).json({ error, code, ...extra });
  }

  // -------------------------------------------------------------------------
  // Settling what the sandbox provider decided (the Worker re-reads the provider, then posts to the ledger)
  // -------------------------------------------------------------------------

  function post(wallet, kind, amountMinor, ref, status) {
    wallet.available += amountMinor;
    wallet.txs.unshift({
      id: randomUUID(), seq: String(++wallet.seq), kind, amount: money(amountMinor), balanceAfter: money(wallet.available),
      status, createdAt: iso(now()), ref,
    });
  }

  /**
   * The card a deposit saves: a new payout destination, so it cools off like an address. `usableAt` is for a seeded
   * card that a spec wants ready. depositedMinor (not on the wire) is what the closed-loop limit counts.
   */
  function cardInstrument(wallet, { usableAt = now() + config.coolingOffMs, createdAt = now(), depositedMinor = 0n } = {}) {
    for (const instrument of wallet.instruments.values()) if (instrument.kind === 'CARD' && instrument.status === 'ACTIVE') return instrument;
    const instrument = {
      id: randomUUID(), kind: 'CARD', status: 'ACTIVE', label: null,
      card: { brand: 'VISA', last4: '4242', expMonth: 12, expYear: 2030 }, crypto: null,
      depositEnabled: true, payoutEnabled: true, usableAfter: iso(usableAt), createdAt: iso(createdAt),
    };
    Object.defineProperty(instrument, 'depositedMinor', { value: depositedMinor, enumerable: false, writable: true });
    wallet.instruments.set(instrument.id, instrument);
    return instrument;
  }

  function settle(wallet) {
    const at = now();
    for (const deposit of wallet.deposits.values()) {
      if (deposit.settleAt === null || deposit.settleAt > at) continue;
      deposit.settleAt = null;
      if (deposit.outcome === 'CREDITED') {
        deposit.status = 'CREDITED';
        deposit.creditedAmount = deposit.amount;
        deposit.creditedAt = iso(at);
        deposit.closedAt = iso(at);
        if (deposit.method === 'CARD') {
          const card = cardInstrument(wallet);
          card.depositedMinor += parseMinor(deposit.amount);
          deposit.instrumentId = card.id;
        }
        post(wallet, 'DEPOSIT', parseMinor(deposit.amount), { type: 'DEPOSIT', id: deposit.id }, 'CREDITED');
      } else {
        deposit.status = deposit.outcome;
        deposit.closedAt = iso(at);
      }
    }
    if (wallet.kycSettle && wallet.kycSettle.at <= at) {
      wallet.kyc = wallet.kycSettle.outcome;
      wallet.kycSettle = null;
    }
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  function summary(account) {
    const wallet = walletOf(account);
    settle(wallet);
    const chips = auth.view(account).bankroll;
    if (config.mode !== 'sandbox' && config.mode !== 'live') return { mode: 'off', realMoney: null, play: { chips, redeemable: false } };
    const reasons = [];
    if (config.paused) reasons.push('PAUSED');
    if (config.regionBlocked) reasons.push('REGION');
    const kycBlocksDeposit = config.kycBeforeDeposit && wallet.kyc !== 'VERIFIED';
    if (wallet.kyc === 'PENDING') reasons.push('KYC_PENDING');
    else if (kycBlocksDeposit) reasons.push('KYC_REQUIRED');
    if (!wallet.limitsChosen) reasons.push('LIMITS_SETUP_REQUIRED');
    if (wallet.selfExcluded) reasons.push('SELF_EXCLUDED');
    if (wallet.restriction !== 'NONE') reasons.push('ACCOUNT_RESTRICTED');
    const depositBlocked = config.paused || config.regionBlocked || kycBlocksDeposit || !wallet.limitsChosen || wallet.selfExcluded
      || wallet.restriction === 'DEPOSITS_BLOCKED' || wallet.restriction === 'FROZEN';
    const withdrawBlocked = config.paused || wallet.kyc !== 'VERIFIED' || wallet.restriction === 'FROZEN' || holdActive(account);
    return {
      mode: config.mode,
      realMoney: {
        state: reasons.length === 0 ? 'ACTIVE' : config.paused || config.regionBlocked ? 'UNAVAILABLE' : 'RESTRICTED',
        reasons,
        asset: asset(),
        decimals: 2,
        available: money(wallet.available),
        pendingWithdrawals: money(wallet.held),
        canDeposit: !depositBlocked && config.methods.deposit.length > 0,
        canWithdraw: !withdrawBlocked && config.methods.withdraw.length > 0,
        methods: { deposit: [...config.methods.deposit], withdraw: [...config.methods.withdraw] },
        cryptoAssets: cryptoOptions().map(({ code, network, label }) => ({ code, network, label })),
        kyc: { status: wallet.kyc, requiredForDeposit: config.kycBeforeDeposit },
        limits: Object.fromEntries(PERIODS.map((p) => [p, wallet.limits[p].active === null ? null : money(wallet.limits[p].active)])),
      },
      play: { chips, redeemable: false },
    };
  }

  function depositView(deposit) {
    const { settleAt: _s, outcome: _o, userId: _u, origin: _origin, next: _n, fingerprint: _f, ...view } = deposit;
    return view;
  }

  function limitsView(wallet) {
    const at = now();
    for (const period of PERIODS) {
      const limit = wallet.limits[period];
      if (limit.pending && limit.pending.effectiveFrom <= at) { limit.active = limit.pending.amount; limit.pending = null; }
    }
    return {
      deposit: Object.fromEntries(PERIODS.map((p) => {
        const limit = wallet.limits[p];
        return [p, {
          active: limit.active === null ? null : money(limit.active),
          pending: limit.pending ? { amount: limit.pending.amount === null ? null : money(limit.pending.amount), effectiveFrom: iso(limit.pending.effectiveFrom) } : null,
        }];
      })),
    };
  }

  function destinationOf(instrument) {
    if (!instrument) return null;
    const display = instrument.kind === 'CARD'
      ? `${instrument.card.brand.charAt(0)}${instrument.card.brand.slice(1).toLowerCase()} •••• ${instrument.card.last4}`
      : instrument.crypto.address;
    return { instrumentId: instrument.id, kind: instrument.kind, display };
  }

  // -------------------------------------------------------------------------
  // Request guards, in the order poker-api applies them (apps/edge/src/http/wallet.ts): the session, then the
  // Idempotency-Key, then the body, then (on the two routes that spend a grant) moneyPrecheck, and only then the
  // Worker, which answers REAL_MONEY_DISABLED when the mode is off.
  // -------------------------------------------------------------------------

  /** Without a payments Worker in an active mode: 403 REAL_MONEY_DISABLED. */
  function moneyOn(res) {
    if (config.mode === 'sandbox' || config.mode === 'live') return true;
    refuse(res, 'REAL_MONEY_DISABLED', 'Real-money play is not available yet.');
    return false;
  }

  /** moneyPrecheck: a verified email and no security hold (here `until` is top-level; the Worker's quote puts it in details). */
  function precheck(res, account) {
    if (!account.emailVerified) { res.status(403).json({ error: 'Confirm your email address first.', code: 'EMAIL_NOT_VERIFIED' }); return false; }
    if (holdActive(account)) {
      res.status(403).json({ error: 'For your security, withdrawals are paused for a while after a recent account change.', code: 'SECURITY_HOLD', until: account.securityHoldUntil });
      return false;
    }
    return true;
  }

  function idempotencyKey(req, res) {
    const key = req.get('Idempotency-Key');
    if (!key || !UUID_V4.test(key)) { refuse(res, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (a UUID v4) with this request.'); return null; }
    return key;
  }

  /** The zod schemas are strict: any other field is 422 VALIDATION. */
  const onlyKeys = (body, allowed) => Object.keys(body).every((key) => allowed.includes(key));
  const validGrant = (value) => typeof value === 'string' && GRANT_ID.test(value);

  /** A :id that is not a UUID is the same 404 as an unknown one. */
  function objectId(req, res, message) {
    if (OBJECT_ID.test(req.params.id)) return req.params.id;
    refuse(res, 'NOT_FOUND', message);
    return null;
  }

  /** The stored answer of an earlier request with this key: the same body replays it (status 200), another is a conflict. */
  function replayed(res, wallet, scope, key, body) {
    const fingerprint = JSON.stringify(body ?? null);
    const earlier = wallet.replies.get(`${scope}:${key}`);
    if (!earlier) return false;
    if (earlier.fingerprint !== fingerprint) { refuse(res, 'IDEMPOTENCY_CONFLICT', 'This key was already used for another request.'); return true; }
    res.status(200).json(earlier.reply());
    return true;
  }
  function remember(wallet, scope, key, body, reply) {
    wallet.replies.set(`${scope}:${key}`, { fingerprint: JSON.stringify(body ?? null), reply });
  }

  /** The Worker's requirement names every method of the purpose; the page narrows it by the account's factors. */
  function stepUpRequired(res, purpose, bind) {
    res.status(403).json({ error: "Confirm it's you to continue.", code: 'STEP_UP_REQUIRED', purpose, bind, methods: [...STEP_UP_METHODS_BY_PURPOSE[purpose]] });
  }

  /** withdrawals.ts cardPayoutRoom: what this card deposited, less what went or is on its way to it. */
  function cardRoom(wallet, instrument) {
    const paid = [...wallet.withdrawals.values()]
      .filter((w) => w.destination?.instrumentId === instrument.id && ['UNDER_REVIEW', 'APPROVED', 'SUBMITTED', 'SETTLED'].includes(w.status))
      .reduce((sum, w) => sum + parseMinor(w.amount), 0n);
    const room = instrument.depositedMinor - paid;
    return room > 0n ? room : 0n;
  }

  function overCardRoom(res, wallet, instrument, amountMinor) {
    if (instrument.kind !== 'CARD') return false;
    const room = cardRoom(wallet, instrument);
    if (amountMinor <= room) return false;
    refuse(res, 'CARD_PAYOUT_LIMIT', 'This card can receive up to that much.', { details: { max: money(room) } });
    return true;
  }

  function install(app) {
    // The log and the one-shot error a spec queued for one route.
    app.use('/api/wallet', (req, res, next) => {
      const path = req.originalUrl.split('?')[0];
      log.push({ method: req.method, path, url: req.originalUrl, idempotencyKey: req.get('Idempotency-Key') ?? null, body: req.body && Object.keys(req.body).length ? req.body : null });
      if (config.mode === 'absent' && path !== '/api/wallet/not-me') { res.status(404).json({ error: 'Not found' }); return; }
      const queued = config.nextError;
      if (queued && queued.path === path && (queued.method ?? 'POST') === req.method) {
        config.nextError = null;
        if (queued.retryAfter) res.setHeader('Retry-After', String(queued.retryAfter));
        res.status(queued.status).json(queued.body);
        return;
      }
      next();
    });

    // Summary and history.
    app.get('/api/wallet', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      res.json(summary(account));
    });

    app.get('/api/wallet/transactions', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      if (config.mode !== 'sandbox' && config.mode !== 'live') { res.json({ items: [], next: null }); return; }
      const wallet = walletOf(account);
      settle(wallet);
      const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? '20'), 10) || 20));
      const start = /^\d+$/.test(String(req.query.cursor ?? '')) ? Number(req.query.cursor) : 0;
      const items = wallet.txs.slice(start, start + limit);
      res.json({ items, next: start + limit < wallet.txs.length ? String(start + limit) : null });
    });

    // Deposits.
    app.post('/api/wallet/deposits', async (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      const key = idempotencyKey(req, res);
      if (!key) return;
      const body = req.body ?? {};
      const method = body.method;
      const amountMinor = parseMinor(body.amount);
      const shape = method === 'CARD' ? ['method', 'amount', 'instrumentId', 'saveCard'] : ['method', 'amount', 'payAsset'];
      if ((method !== 'CARD' && method !== 'CRYPTO') || amountMinor === null || !onlyKeys(body, shape)) { refuse(res, 'VALIDATION', 'Enter an amount like 50.00 and a payment method.'); return; }
      if (!moneyOn(res)) return;
      const wallet = walletOf(account);
      settle(wallet);
      if (amountMinor <= 0n) { refuse(res, 'VALIDATION', 'Enter an amount above zero.'); return; }
      if (!config.methods.deposit.includes(method)) { refuse(res, 'METHOD_DISABLED', 'This payment method is not available right now.'); return; }
      if (config.paused) { refuse(res, 'PAYMENTS_PAUSED', 'Payments are paused.', { retryable: true }); return; }
      if (config.regionBlocked) { refuse(res, 'REGION_BLOCKED', 'Not available in your region.'); return; }
      if (amountMinor < 500n) { refuse(res, 'AMOUNT_BELOW_MIN', 'Below the minimum.', { details: { min: '5.00' } }); return; }
      if (amountMinor > 500_000n) { refuse(res, 'AMOUNT_ABOVE_MAX', 'Above the maximum.', { details: { max: '5000.00' } }); return; }
      let option = null;
      if (method === 'CRYPTO') {
        option = cryptoOptions().find((a) => a.code === body.payAsset) ?? null;
        if (!option) { refuse(res, 'ASSET_UNSUPPORTED', 'This currency is not available.'); return; }
      }
      if (replayed(res, wallet, 'deposit', key, body)) return;
      const view = summary(account).realMoney;
      if (wallet.restriction !== 'NONE' && wallet.restriction !== 'WITHDRAWALS_MANUAL') { refuse(res, 'ACCOUNT_RESTRICTED', 'Payments are restricted.'); return; }
      if (wallet.selfExcluded) { refuse(res, 'SELF_EXCLUDED', 'Deposits are closed during a self-exclusion.'); return; }
      if (wallet.kyc === 'PENDING' && config.kycBeforeDeposit) { refuse(res, 'KYC_PENDING', 'Your identity check is in progress.'); return; }
      if (config.kycBeforeDeposit && wallet.kyc !== 'VERIFIED') { refuse(res, 'KYC_REQUIRED', 'Verify your identity first.'); return; }
      if (!wallet.limitsChosen) { refuse(res, 'LIMITS_SETUP_REQUIRED', 'Choose your deposit limits first.'); return; }
      const open = [...wallet.deposits.values()].filter((d) => d.status === 'CREATED' || d.status === 'PENDING').length;
      if (open >= 3) { refuse(res, 'TOO_MANY_PENDING', 'Too many deposits in progress.'); return; }
      const dayLimit = wallet.limits.DAY.active;
      if (dayLimit !== null) {
        const since = now() - DAY_MS;
        const used = [...wallet.deposits.values()].filter((d) => d.status === 'CREDITED' && Date.parse(d.createdAt) > since)
          .reduce((sum, d) => sum + parseMinor(d.amount), 0n);
        if (used + amountMinor > dayLimit) {
          refuse(res, 'DEPOSIT_LIMIT_EXCEEDED', 'Over your deposit limit.', { details: { remaining: money(dayLimit > used ? dayLimit - used : 0n) } });
          return;
        }
      }
      const at = now();
      const id = randomUUID();
      const origin = origins.includes(req.get('Origin') ?? '') ? req.get('Origin') : origins[0];
      const deposit = {
        id, method, status: method === 'CARD' ? 'CREATED' : 'PENDING', asset: view.asset, amount: money(amountMinor), creditedAmount: null,
        reversedAmount: '0.00', refundHeldAmount: '0.00', payAsset: option?.code ?? null, payNetwork: option?.network ?? null, txHash: null,
        confirmations: method === 'CRYPTO' ? 0 : null, instrumentId: null, statusReason: null, createdAt: iso(at), expiresAt: iso(at + 30 * 60_000),
        creditedAt: null, closedAt: null,
        // Fixture only.
        userId: account.id, origin, settleAt: null, outcome: null, next: null,
      };
      deposit.next = method === 'CARD'
        ? { type: 'REDIRECT', url: `${fixtureOrigin}/sandbox/pay/${id}`, expiresAt: deposit.expiresAt }
        : {
            type: 'CRYPTO_INVOICE', asset: option.code, network: option.network, address: DEPOSIT_ADDRESS[option.network], memo: null,
            payAmount: (Number(option.perEuro) * Number(money(amountMinor))).toFixed(8), expiresAt: iso(at + 60 * 60_000),
            minConfirmations: option.minConfirmations,
          };
      wallet.deposits.set(id, deposit);
      const reply = () => ({ deposit: depositView(deposit), next: deposit.status === 'CREATED' || deposit.status === 'PENDING' ? deposit.next : null });
      remember(wallet, 'deposit', key, body, reply);
      res.status(201).json(reply());
    });

    app.get('/api/wallet/deposits/:id', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      const id = objectId(req, res, 'That deposit does not exist.');
      if (!id || !moneyOn(res)) return;
      const wallet = walletOf(account);
      settle(wallet);
      const deposit = wallet.deposits.get(id);
      if (!deposit) { refuse(res, 'NOT_FOUND', 'That deposit does not exist.'); return; }
      res.json({ deposit: depositView(deposit) });
    });

    app.post('/api/wallet/deposits/:id/cancel', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      const id = objectId(req, res, 'That deposit does not exist.');
      if (!id || !moneyOn(res)) return;
      const wallet = walletOf(account);
      settle(wallet);
      const deposit = wallet.deposits.get(id);
      if (!deposit) { refuse(res, 'NOT_FOUND', 'That deposit does not exist.'); return; }
      if (deposit.status === 'CANCELLED') { res.json({ deposit: depositView(deposit) }); return; }
      if (deposit.status !== 'CREATED' && deposit.status !== 'PENDING') { refuse(res, 'INVALID_STATE', 'This deposit can no longer be cancelled.'); return; }
      Object.assign(deposit, { status: 'CANCELLED', closedAt: iso(now()), settleAt: null });
      res.json({ deposit: depositView(deposit) });
    });

    // Payout destinations.
    app.get('/api/wallet/instruments', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      if (config.mode !== 'sandbox' && config.mode !== 'live') { res.json({ instruments: [] }); return; }
      const wallet = walletOf(account);
      settle(wallet);
      res.json({ instruments: [...wallet.instruments.values()].filter((i) => i.status === 'ACTIVE') });
    });

    /** instruments.ts prepareAddress: the asset on offer to this player, then the network's address rules. */
    function prepared(res, body) {
      const option = cryptoOptions().find((a) => a.code === body?.asset);
      if (!option) { refuse(res, 'ASSET_UNSUPPORTED', 'Payouts in this currency are not available.'); return null; }
      if (body.memo !== undefined && body.memo !== null && body.memo !== '') { refuse(res, 'VALIDATION', 'A memo is not supported for this network.'); return null; }
      const address = normalizeAddress(option.network, body.address);
      if (!address) { refuse(res, 'ADDRESS_INVALID', 'That is not a valid address.'); return null; }
      return { option, ...address };
    }

    app.post('/api/wallet/instruments/crypto/prepare', async (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      const body = req.body ?? {};
      if (typeof body.asset !== 'string' || typeof body.address !== 'string' || !body.address || !onlyKeys(body, ['asset', 'address', 'memo'])) { refuse(res, 'VALIDATION', 'Enter the currency and the address.'); return; }
      if (!moneyOn(res)) return;
      const checked = prepared(res, body);
      if (!checked) return;
      let bind = await stepUpBind(payoutDestinationAction({ userId: account.id, asset: checked.option.code, addressNormalized: checked.normalized, memo: null }));
      if (config.tamperBind === 'prepare') { config.tamperBind = null; bind = await stepUpBind(payoutDestinationAction({ userId: account.id, asset: checked.option.code, addressNormalized: `${checked.normalized}x`, memo: null })); }
      res.json({
        normalized: checked.display, bind,
        ownershipChallenge: `Hold'em Live payout address ownership\nuser: ${account.id}\nasset: ${checked.option.code}\naddress: ${checked.normalized}`,
      });
    });

    // The single-use grant is this route's idempotency key: the header is required but not stored (AHW-7).
    app.post('/api/wallet/instruments/crypto', async (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      if (!idempotencyKey(req, res)) return;
      const body = req.body ?? {};
      if (typeof body.asset !== 'string' || typeof body.address !== 'string' || !body.address || !validGrant(body.stepUpGrantId)
        || !onlyKeys(body, ['asset', 'address', 'memo', 'label', 'stepUpGrantId', 'ownership'])) {
        refuse(res, 'VALIDATION', "Enter the currency and the address, then confirm it's you.");
        return;
      }
      if (!precheck(res, account) || !moneyOn(res)) return;
      const wallet = walletOf(account);
      if (!config.methods.withdraw.includes('CRYPTO')) { refuse(res, 'METHOD_DISABLED', 'Adding payout addresses is not available right now.'); return; }
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null;
      if (label !== null && !/^[\p{L}\p{N} ._'-]{1,40}$/u.test(label)) { refuse(res, 'VALIDATION', 'A label is 1 to 40 letters, digits or spaces.'); return; }
      const checked = prepared(res, body);
      if (!checked) return;
      const bind = await stepUpBind(payoutDestinationAction({ userId: account.id, asset: checked.option.code, addressNormalized: checked.normalized, memo: null }));
      const earlier = [...wallet.instruments.values()].find((i) => i.grantId === body.stepUpGrantId && i.normalized === checked.normalized);
      if (earlier) { res.status(200).json({ instrument: earlier }); return; }
      // The unique check fails inside the Worker's transaction, which rolls the grant back: nothing is spent.
      const active = [...wallet.instruments.values()].filter((i) => i.status === 'ACTIVE');
      if (active.some((i) => i.crypto && i.crypto.asset === checked.option.code && i.normalized === checked.normalized)) {
        const live = auth.grantUsable(body.stepUpGrantId, { purpose: 'payout_destination', bind });
        if (!live) { stepUpRequired(res, 'payout_destination', bind); return; }
        refuse(res, 'DESTINATION_EXISTS', 'This address is already saved.');
        return;
      }
      if (!auth.consumeGrant(body.stepUpGrantId, { purpose: 'payout_destination', bind })) { stepUpRequired(res, 'payout_destination', bind); return; }
      const at = now();
      const instrument = {
        id: randomUUID(), kind: 'CRYPTO_ADDRESS', status: 'ACTIVE', label, card: null,
        crypto: { asset: checked.option.code, network: checked.option.network, address: checked.display, memo: null },
        depositEnabled: false, payoutEnabled: true, usableAfter: iso(at + config.coolingOffMs), createdAt: iso(at),
      };
      wallet.instruments.set(instrument.id, instrument);
      // Fixture only (not on the wire): what DESTINATION_EXISTS and a replay compare.
      Object.defineProperty(instrument, 'normalized', { value: checked.normalized, enumerable: false });
      Object.defineProperty(instrument, 'grantId', { value: body.stepUpGrantId, enumerable: false });
      auth.recordEvent(account, 'PAYOUT_DESTINATION_ADDED', req, { instrumentId: instrument.id });
      res.status(201).json({ instrument });
    });

    app.delete('/api/wallet/instruments/:id', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      const id = objectId(req, res, 'That payout destination does not exist.');
      if (!id || !moneyOn(res)) return;
      const wallet = walletOf(account);
      const instrument = wallet.instruments.get(id);
      if (!instrument) { refuse(res, 'NOT_FOUND', 'That payout destination does not exist.'); return; }
      if (instrument.status === 'REVOKED') { res.status(204).end(); return; }
      const inUse = [...wallet.withdrawals.values()].some((w) => w.destination?.instrumentId === instrument.id && ['UNDER_REVIEW', 'APPROVED', 'SUBMITTED'].includes(w.status));
      if (inUse) { refuse(res, 'INSTRUMENT_IN_USE', 'A withdrawal to this destination is still open.'); return; }
      instrument.status = 'REVOKED';
      res.status(204).end();
    });

    // Withdrawals. withdrawals.ts: the destination first, then what is open to this player, then the amount.
    app.post('/api/wallet/withdrawals/quote', async (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      const body = req.body ?? {};
      const amountMinor = parseMinor(body.amount);
      if (amountMinor === null || typeof body.instrumentId !== 'string' || !OBJECT_ID.test(body.instrumentId) || !onlyKeys(body, ['instrumentId', 'amount'])) {
        refuse(res, 'VALIDATION', 'Choose a destination and an amount like 50.00.');
        return;
      }
      if (!moneyOn(res)) return;
      const wallet = walletOf(account);
      settle(wallet);
      if (amountMinor <= 0n) { refuse(res, 'VALIDATION', 'Enter an amount above zero.'); return; }
      const instrument = wallet.instruments.get(body.instrumentId);
      if (!instrument) { refuse(res, 'NOT_FOUND', 'That payout destination does not exist.'); return; }
      if (instrument.status !== 'ACTIVE' || !instrument.payoutEnabled) { refuse(res, 'DESTINATION_UNAVAILABLE', 'This destination cannot receive payouts.'); return; }
      if (Date.parse(instrument.usableAfter) > now()) {
        refuse(res, 'DESTINATION_COOLING_OFF', 'This new payout destination can be used a little later.', { details: { usableAfter: instrument.usableAfter } });
        return;
      }
      const rail = instrument.kind === 'CARD' ? 'CARD' : 'CRYPTO';
      if (holdActive(account)) { refuse(res, 'SECURITY_HOLD', 'Withdrawals are paused for a while after a security change.', { details: { until: account.securityHoldUntil } }); return; }
      if (config.paused) { refuse(res, 'PAYMENTS_PAUSED', 'Payments are paused.', { retryable: true }); return; }
      if (!config.methods.withdraw.includes(rail)) { refuse(res, 'METHOD_DISABLED', 'Withdrawals by this method are not available right now.'); return; }
      if (wallet.kyc !== 'VERIFIED') { refuse(res, 'KYC_REQUIRED', 'Verify your identity before you withdraw.'); return; }
      if (wallet.restriction === 'FROZEN') { refuse(res, 'ACCOUNT_RESTRICTED', 'Withdrawals are on hold for your account. Contact support.'); return; }
      const feeMinor = rail === 'CARD' ? CARD_FEE : CRYPTO_FEE;
      if (amountMinor < 1_000n) { refuse(res, 'AMOUNT_BELOW_MIN', 'Below the minimum.', { details: { min: '10.00' } }); return; }
      if (amountMinor > wallet.available) { refuse(res, 'INSUFFICIENT_FUNDS', 'Your balance is too low for this withdrawal.', { details: { available: money(wallet.available) } }); return; }
      if (overCardRoom(res, wallet, instrument, amountMinor)) return;
      if (feeMinor >= amountMinor) { refuse(res, 'AMOUNT_BELOW_MIN', 'This amount does not cover the payout fee.'); return; }
      const id = randomUUID();
      const option = instrument.crypto ? CRYPTO_ASSETS.find((a) => a.code === instrument.crypto.asset) : null;
      const quote = {
        id, asset: asset(), amount: money(amountMinor), fee: money(feeMinor), youReceive: money(amountMinor - feeMinor),
        receiveAsset: option ? option.code : asset(),
        receiveEstimate: option ? (Number(option.perEuro) * Number(money(amountMinor - feeMinor))).toFixed(8) : null,
        rate: option ? option.perEuro : null,
        expiresAt: iso(now() + config.quoteTtlMs),
      };
      const action = withdrawalAction({
        userId: account.id, asset: quote.asset, instrumentId: instrument.id, amountMinor: amountMinor.toString(), feeMinor: feeMinor.toString(), quoteId: id,
      });
      const bind = await stepUpBind(action);
      wallet.quotes.set(id, { quote, bind, instrumentId: instrument.id, amountMinor, feeMinor, used: false });
      let shown = bind;
      if (config.tamperBind === 'quote') { config.tamperBind = null; shown = await stepUpBind({ ...action, amountMinor: (amountMinor * 10n).toString() }); }
      res.json({ quote, stepUp: { purpose: 'withdrawal', bind: shown, methods: [...STEP_UP_METHODS_BY_PURPOSE.withdrawal] } });
    });

    app.post('/api/wallet/withdrawals', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      const key = idempotencyKey(req, res);
      if (!key) return;
      const body = req.body ?? {};
      if (typeof body.quoteId !== 'string' || !OBJECT_ID.test(body.quoteId) || !validGrant(body.stepUpGrantId) || !onlyKeys(body, ['quoteId', 'stepUpGrantId'])) {
        refuse(res, 'VALIDATION', "Get a new quote and confirm it's you.");
        return;
      }
      if (!precheck(res, account) || !moneyOn(res)) return;
      const wallet = walletOf(account);
      settle(wallet);
      const entry = wallet.quotes.get(body.quoteId);
      if (!entry) { refuse(res, 'QUOTE_EXPIRED', 'That quote is not valid. Get a new quote.'); return; }
      if (replayed(res, wallet, 'withdrawal', key, { quoteId: body.quoteId })) return;
      if (wallet.kyc !== 'VERIFIED') { refuse(res, 'KYC_REQUIRED', 'Verify your identity before you withdraw.'); return; }
      if (wallet.restriction === 'FROZEN') { refuse(res, 'ACCOUNT_RESTRICTED', 'Withdrawals are on hold for your account. Contact support.'); return; }
      if (entry.used || Date.parse(entry.quote.expiresAt) <= now()) { refuse(res, 'QUOTE_EXPIRED', 'That quote expired. Get a new quote.'); return; }
      const instrument = wallet.instruments.get(entry.instrumentId);
      if (!instrument || instrument.status !== 'ACTIVE' || !instrument.payoutEnabled || Date.parse(instrument.usableAfter) > now()) {
        refuse(res, 'DESTINATION_UNAVAILABLE', 'This destination cannot receive payouts right now.');
        return;
      }
      if (overCardRoom(res, wallet, instrument, entry.amountMinor)) return;
      // A grant that expired between the confirmation and the request: the Worker answers STEP_UP_REQUIRED and nothing is spent.
      if (config.rejectNextGrant) { config.rejectNextGrant = false; stepUpRequired(res, 'withdrawal', entry.bind); return; }
      if (!auth.consumeGrant(body.stepUpGrantId, { purpose: 'withdrawal', bind: entry.bind })) { stepUpRequired(res, 'withdrawal', entry.bind); return; }
      if (entry.amountMinor > wallet.available) { refuse(res, 'INSUFFICIENT_FUNDS', 'Your balance is too low for this withdrawal.'); return; }
      entry.used = true;
      const at = now();
      const withdrawal = {
        id: randomUUID(), kind: 'PLAYER', status: 'UNDER_REVIEW', displayStatus: WITHDRAWAL_DISPLAY_STATUS.UNDER_REVIEW, asset: entry.quote.asset,
        amount: entry.quote.amount, fee: entry.quote.fee, youReceive: entry.quote.youReceive,
        payoutAsset: instrument.crypto?.asset ?? null, payoutAmount: entry.quote.receiveEstimate,
        destination: destinationOf(instrument), txHash: null, failureReason: null, createdAt: iso(at), settledAt: null, closedAt: null,
      };
      wallet.withdrawals.set(withdrawal.id, withdrawal);
      wallet.held += entry.amountMinor;
      post(wallet, 'WITHDRAWAL', -entry.amountMinor, { type: 'WITHDRAWAL', id: withdrawal.id }, 'UNDER_REVIEW');
      const reply = () => ({ withdrawal });
      remember(wallet, 'withdrawal', key, { quoteId: body.quoteId }, reply);
      res.status(201).json(reply());
    });

    app.get('/api/wallet/withdrawals', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      if (config.mode !== 'sandbox' && config.mode !== 'live') { res.json({ withdrawals: [], next: null }); return; }
      const list = [...walletOf(account).withdrawals.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      res.json({ withdrawals: list, next: null });
    });

    app.get('/api/wallet/withdrawals/:id', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      const id = objectId(req, res, 'That withdrawal does not exist.');
      if (!id || !moneyOn(res)) return;
      const withdrawal = walletOf(account).withdrawals.get(id);
      if (!withdrawal) { refuse(res, 'NOT_FOUND', 'That withdrawal does not exist.'); return; }
      res.json({ withdrawal });
    });

    app.post('/api/wallet/withdrawals/:id/cancel', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      const id = objectId(req, res, 'That withdrawal does not exist.');
      if (!id || !moneyOn(res)) return;
      if (!config.allowCancel) { refuse(res, 'CANCEL_DISABLED', 'Withdrawals cannot be cancelled once requested.'); return; }
      const wallet = walletOf(account);
      const withdrawal = wallet.withdrawals.get(id);
      if (!withdrawal) { refuse(res, 'NOT_FOUND', 'That withdrawal does not exist.'); return; }
      if (withdrawal.status !== 'UNDER_REVIEW') { refuse(res, 'INVALID_STATE', 'This withdrawal can no longer be cancelled.'); return; }
      const amountMinor = parseMinor(withdrawal.amount);
      Object.assign(withdrawal, { status: 'CANCELLED', displayStatus: WITHDRAWAL_DISPLAY_STATUS.CANCELLED, closedAt: iso(now()) });
      wallet.held -= amountMinor;
      post(wallet, 'WITHDRAWAL_RELEASED', amountMinor, { type: 'WITHDRAWAL', id: withdrawal.id }, 'CANCELLED');
      res.json({ withdrawal });
    });

    // Responsible gaming: a stricter limit applies now, a looser one or a removal after 24 h (the database trigger's rule).
    // Written by poker-api with the runtime login, so these work whatever the payments mode.
    app.get('/api/wallet/limits', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      res.json(limitsView(walletOf(account)));
    });

    app.post('/api/wallet/limits', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      const wallet = walletOf(account);
      const { period, amount } = req.body ?? {};
      const amountMinor = amount === null ? null : parseMinor(amount);
      if (!PERIODS.includes(period) || (amount !== null && amountMinor === null) || !onlyKeys(req.body ?? {}, ['period', 'amount'])) { refuse(res, 'VALIDATION', 'Choose a period and an amount like 100.00, or no limit.'); return; }
      if (amountMinor !== null && amountMinor <= 0n) { refuse(res, 'VALIDATION', 'Enter a limit above zero, or choose no limit. To stop depositing for a while, take a break instead.'); return; }
      limitsView(wallet);
      const limit = wallet.limits[period];
      const stricter = amountMinor !== null && (limit.active === null || amountMinor <= limit.active);
      if (stricter) { limit.active = amountMinor; limit.pending = null; } else if (amountMinor !== limit.active) limit.pending = { amount: amountMinor, effectiveFrom: now() + DAY_MS };
      else limit.pending = null;
      wallet.limitsChosen = true;
      res.json(limitsView(wallet));
    });

    // Self-exclusion, written by poker-api like the limits. The rules are the database trigger's: a timed break that ended
    // reopens 24 h after the player asks, an indefinite one waits for an administrator, and a running one cannot be asked about.
    function exclusionView(wallet) {
      const row = wallet.exclusion;
      if (!row || (row.accessRestoredAt !== null && row.accessRestoredAt <= now())) {
        return { active: false, kind: null, endsAt: null, canRequestReturn: false, requestedAt: null, accessRestoredAt: null };
      }
      const running = row.endsAt !== null && row.endsAt > now();
      return {
        active: true, kind: row.endsAt === null ? 'INDEFINITE' : 'DEFINITE', endsAt: row.endsAt === null ? null : iso(row.endsAt),
        canRequestReturn: !running && row.requestedAt === null, requestedAt: row.requestedAt === null ? null : iso(row.requestedAt),
        accessRestoredAt: row.accessRestoredAt === null ? null : iso(row.accessRestoredAt),
      };
    }

    app.get('/api/account/self-exclusion', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      res.json(exclusionView(walletOf(account)));
    });

    app.post('/api/account/self-exclusion/reactivation', (req, res) => {
      const account = auth.authed(req, res);
      if (!account) return;
      log.push({ method: req.method, path: req.originalUrl.split('?')[0], url: req.originalUrl, idempotencyKey: null, body: null });
      const wallet = walletOf(account);
      const view = exclusionView(wallet);
      if (!view.active) { refuse(res, 'INVALID_STATE', 'You do not have a self-exclusion in force.'); return; }
      if (view.endsAt !== null && Date.parse(view.endsAt) > now()) { refuse(res, 'EXCLUSION_NOT_ENDED', 'Your break has not ended yet.', { details: { endsAt: view.endsAt } }); return; }
      if (wallet.exclusion.requestedAt === null) {
        wallet.exclusion.requestedAt = now();
        if (wallet.exclusion.endsAt !== null) wallet.exclusion.accessRestoredAt = now() + DAY_MS;
      }
      res.json(exclusionView(wallet));
    });

    // Identity verification.
    app.post('/api/wallet/kyc/session', (req, res) => {
      const account = auth.authed(req, res);
      if (!account || !moneyOn(res)) return;
      const wallet = walletOf(account);
      settle(wallet);
      if (wallet.kyc === 'VERIFIED') { refuse(res, 'INVALID_STATE', 'Your identity is already verified.'); return; }
      const sdkToken = `kyc-${randomUUID()}`;
      const expiresAt = iso(now() + 10 * 60_000);
      const origin = origins.includes(req.get('Origin') ?? '') ? req.get('Origin') : origins[0];
      wallet.kycSession = { token: sdkToken, origin };
      if (config.kycProvider === 'sumsub') { res.json({ provider: 'sumsub', sdkToken, expiresAt }); return; }
      if (config.kycProvider === 'silent') { res.json({ provider: 'sandbox-kyc', sdkToken, expiresAt }); return; }
      res.json({ provider: 'sandbox-kyc', sdkToken, expiresAt, url: `${fixtureOrigin}/sandbox/kyc/${encodeURIComponent(sdkToken)}` });
    });

    // "This wasn't me" from a payments email: withdrawals manual, every destination of the last 72 h gone (and the one the
    // email named), unsent withdrawals cancelled; poker-api then ends every session and sets the hold. Without a payments
    // Worker every token is invalid. No session needed.
    app.post('/api/wallet/not-me', (req, res) => {
      const token = req.body?.token;
      const match = typeof token === 'string' ? /^wallet-not-me\.([A-Za-z0-9_-]+)\.(valid|expired)(?:\.([0-9a-f-]{36}))?$/.exec(token) : null;
      const account = match ? auth.accountById(match[1]) : null;
      if (!match || !account || match[2] !== 'valid' || (config.mode !== 'sandbox' && config.mode !== 'live')) { refuse(res, 'TOKEN_INVALID', 'This link is not valid or has expired.'); return; }
      const wallet = walletOf(account);
      wallet.restriction = wallet.restriction === 'NONE' || wallet.restriction === 'WITHDRAWALS_MANUAL' ? 'WITHDRAWALS_MANUAL' : 'FROZEN';
      const since = now() - 72 * 3_600_000;
      for (const instrument of wallet.instruments.values()) {
        if (Date.parse(instrument.createdAt) > since || instrument.id === match[3]) instrument.status = 'REVOKED';
      }
      for (const withdrawal of wallet.withdrawals.values()) {
        if (withdrawal.status !== 'UNDER_REVIEW') continue;
        const amountMinor = parseMinor(withdrawal.amount);
        Object.assign(withdrawal, { status: 'CANCELLED', displayStatus: WITHDRAWAL_DISPLAY_STATUS.CANCELLED, closedAt: iso(now()) });
        wallet.held -= amountMinor;
        post(wallet, 'WITHDRAWAL_RELEASED', amountMinor, { type: 'WITHDRAWAL', id: withdrawal.id }, 'CANCELLED');
      }
      auth.lockdownSessions(account, DAY_MS);
      auth.recordEvent(account, 'NOT_ME_REPORTED', req, { source: 'payments' });
      res.json({ secured: true });
    });

    // The payments Worker's sandbox pages (poker-payments, outside production): a hosted payment page and a KYC page,
    // with its headers: form-action must allow the 303 back to the site, or Chromium stops the navigation.
    const sandboxPage = (res, origin, status, title, body) => {
      res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${origin}; frame-ancestors 'none'; base-uri 'none'`);
      res.status(status).type('html').send(page(title, body));
    };

    app.get('/sandbox/pay/:id', (req, res) => {
      const deposit = [...wallets.values()].map((w) => w.deposits.get(req.params.id)).find(Boolean);
      if (!deposit) { res.status(404).type('html').send(page('Not found', '<h1>Payment not found</h1>')); return; }
      if (deposit.status === 'CREATED') deposit.status = 'PENDING';
      const action = (outcome, label) => `<form method="post" action="/sandbox/pay/${escapeHtml(deposit.id)}/${outcome}"><button type="submit">${label}</button></form>`;
      sandboxPage(res, deposit.origin, 200, 'Sandbox payment', `<h1>Sandbox payment</h1>`
        + `<p class="note">Test money (TEST_EUR). No card is charged.</p>`
        + `<p>Amount: <strong>${escapeHtml(deposit.amount)} ${escapeHtml(deposit.asset)}</strong></p>`
        + action('approve', 'Approve test payment') + action('decline', 'Decline test payment') + action('cancel', 'Cancel and go back'));
    });

    app.post('/sandbox/pay/:id/:outcome', (req, res) => {
      const deposit = [...wallets.values()].map((w) => w.deposits.get(req.params.id)).find(Boolean);
      const outcome = { approve: 'CREDITED', decline: 'FAILED', cancel: 'CANCELLED' }[req.params.outcome];
      if (!deposit || !outcome) { res.status(404).end(); return; }
      if (deposit.status === 'CREATED' || deposit.status === 'PENDING') {
        deposit.status = outcome === 'CREDITED' ? 'CONFIRMED' : 'PENDING';
        deposit.outcome = outcome;
        // The provider's notification arrives a moment after the browser comes back.
        deposit.settleAt = now() + (outcome === 'CREDITED' ? config.settleDelayMs : 300);
      }
      // As a provider return URL: the outcome in the query string is a claim the page must not trust.
      res.redirect(303, `${deposit.origin}/wallet?deposit=${encodeURIComponent(deposit.id)}&ppp_status=OK&status=success`);
    });

    app.get('/sandbox/kyc/:token', (req, res) => {
      const action = (outcome, label) => `<form method="post" action="/sandbox/kyc/${encodeURIComponent(req.params.token)}/${outcome}"><button type="submit">${label}</button></form>`;
      const wallet = [...wallets.values()].find((w) => w.kycSession?.token === req.params.token);
      sandboxPage(res, wallet?.kycSession.origin ?? origins[0], 200, 'Sandbox identity check', `<h1>Sandbox identity check</h1>`
        + `<p class="note">No documents needed: choose the result.</p>`
        + action('approve', 'Approve verification') + action('reject', 'Reject verification'));
    });

    app.post('/sandbox/kyc/:token/:outcome', (req, res) => {
      const wallet = [...wallets.values()].find((w) => w.kycSession?.token === req.params.token);
      const outcome = { approve: 'VERIFIED', reject: 'REJECTED' }[req.params.outcome];
      if (!wallet || !outcome) { res.status(404).end(); return; }
      wallet.kyc = 'PENDING';
      wallet.kycSettle = { outcome, at: now() + config.kycDelayMs };
      res.redirect(303, `${wallet.kycSession.origin}/wallet/verify/return?status=approved`);
    });

    // Test controls.
    app.post('/__test/wallet', (req, res) => {
      const body = req.body ?? {};
      for (const key of ['mode', 'kycProvider', 'kycBeforeDeposit', 'eea', 'paused', 'regionBlocked', 'allowCancel', 'coolingOffMs', 'settleDelayMs',
        'kycDelayMs', 'quoteTtlMs', 'nextError', 'rejectNextGrant', 'tamperBind']) {
        if (body[key] !== undefined) config[key] = body[key];
      }
      if (body.methods) config.methods = { ...config.methods, ...body.methods };
      const account = body.username ? auth.accountByName(body.username) : auth.current();
      if (account) {
        const wallet = walletOf(account);
        for (const key of ['kyc', 'limitsChosen', 'selfExcluded', 'restriction']) if (body[key] !== undefined) wallet[key] = body[key];
        // { endsInMs } is a timed break (negative: already over); { indefinite: true } has no end.
        if (body.exclusion) {
          wallet.selfExcluded = true;
          wallet.exclusion = { endsAt: body.exclusion.indefinite ? null : now() + body.exclusion.endsInMs, requestedAt: null, accessRestoredAt: null };
        }
        if (body.limits) for (const period of PERIODS) if (body.limits[period] !== undefined) wallet.limits[period] = { active: body.limits[period] === null ? null : parseMinor(body.limits[period]), pending: null };
        if (typeof body.available === 'string') {
          const target = parseMinor(body.available);
          if (target !== wallet.available) post(wallet, 'ADJUSTMENT', target - wallet.available, null, null);
        }
        // A card past its cooling-off; `{ deposited: "30.00" }` sets what it may receive back.
        if (body.seedCard) {
          const deposited = typeof body.seedCard === 'object' ? parseMinor(body.seedCard.deposited) : 1_000_000n;
          cardInstrument(wallet, { usableAt: now() - 1_000, createdAt: now() - 4 * DAY_MS, depositedMinor: deposited });
        }
        if (body.seedAddress) {
          const instrument = {
            id: randomUUID(), kind: 'CRYPTO_ADDRESS', status: 'ACTIVE', label: body.seedAddress.label ?? null, card: null,
            crypto: { asset: body.seedAddress.asset ?? 'BTC', network: body.seedAddress.network ?? 'bitcoin', address: body.seedAddress.address, memo: null },
            depositEnabled: false, payoutEnabled: true, usableAfter: iso(now() + (body.seedAddress.coolingOffMs ?? -1_000)), createdAt: iso(now() - 4 * DAY_MS),
          };
          wallet.instruments.set(instrument.id, instrument);
        }
        // A history: `history` deposits of 10.00 credited, oldest first (newest at the top of the list).
        for (let i = 0; i < (body.history ?? 0); i++) {
          const id = randomUUID();
          wallet.deposits.set(id, {
            id, method: 'CARD', status: 'CREDITED', asset: asset(), amount: '10.00', creditedAmount: '10.00', reversedAmount: '0.00', refundHeldAmount: '0.00',
            payAsset: null, payNetwork: null, txHash: null, confirmations: null, instrumentId: null, statusReason: null,
            createdAt: iso(now() - (body.history - i) * 60_000), expiresAt: iso(now()), creditedAt: iso(now()), closedAt: iso(now()),
            userId: account.id, origin: origins[0], settleAt: null, outcome: null, next: null,
          });
          post(wallet, 'DEPOSIT', 1_000n, { type: 'DEPOSIT', id }, 'CREDITED');
        }
        if (body.reversal) post(wallet, 'REVERSAL', -parseMinor(body.reversal), { type: 'REVERSAL', id: randomUUID() }, 'REVERSED');
      }
      res.json({ ok: true, mode: config.mode });
    });

    // The crypto payment of the newest open crypto deposit: seen on chain (1 confirmation) or confirmed (credited).
    app.post('/__test/wallet/crypto-paid', (req, res) => {
      const account = auth.current();
      const wallet = account ? walletOf(account) : null;
      const deposit = wallet ? [...wallet.deposits.values()].reverse().find((d) => d.method === 'CRYPTO' && d.status === 'PENDING') : null;
      if (!deposit) { res.status(404).json({ error: 'no open crypto deposit' }); return; }
      deposit.txHash = 'a'.repeat(64);
      if (req.body?.stage === 'seen') deposit.confirmations = 1;
      else { deposit.confirmations = deposit.next.minConfirmations; deposit.status = 'CONFIRMED'; deposit.outcome = 'CREDITED'; deposit.settleAt = now(); }
      res.json({ ok: true, depositId: deposit.id });
    });

    app.get('/__test/wallet', (_req, res) => {
      const account = auth.current();
      const wallet = account ? walletOf(account) : null;
      if (wallet) settle(wallet);
      res.json({
        mode: config.mode,
        log,
        wallet: wallet && {
          kyc: wallet.kyc, available: money(wallet.available), held: money(wallet.held), limitsChosen: wallet.limitsChosen, restriction: wallet.restriction,
          deposits: [...wallet.deposits.values()].map(depositView),
          instruments: [...wallet.instruments.values()],
          withdrawals: [...wallet.withdrawals.values()],
        },
      });
    });

    // A payments "This wasn't me" token for this user (the Worker signs real ones with NOTIFY_LINK_SECRET).
    app.post('/__test/wallet/not-me-token', (req, res) => {
      const account = req.body?.username ? auth.accountByName(req.body.username) : auth.current();
      if (!account) { res.status(404).json({ error: 'no such user' }); return; }
      const subject = req.body?.subject ? `.${req.body.subject}` : '';
      res.json({ token: `wallet-not-me.${account.id}.${req.body?.expired ? 'expired' : 'valid'}${subject}` });
    });
  }

  return { install, reset };
}
