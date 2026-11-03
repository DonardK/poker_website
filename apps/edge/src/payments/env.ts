/**
 * Bindings of the poker-payments Worker (apps/edge/wrangler.payments.jsonc;
 * docs/money/WALLET.md section 3.1). The vars and provider secrets are
 * PaymentsVars (config.ts). poker-api never sees any of this: it reaches the
 * Worker only through the PAYMENTS service binding (contract.ts).
 */
import type { PaymentsVars } from "./config";
import type { PayoutDispatcher } from "./actors/payout-dispatcher";
import type { SandboxPsp } from "./actors/sandbox-psp";

export interface PaymentsEnv extends PaymentsVars {
  /** Hyperdrive for the poker_payments_app login (caching disabled). Absent: every money call is 503. */
  HYPERDRIVE_PAYMENTS?: Hyperdrive;
  /** Singleton "payouts": payout dispatch, inbox and outbox sweeps, daily reconciliation. */
  PAYOUT_DISPATCHER?: DurableObjectNamespace<PayoutDispatcher>;
  /** The built-in sandbox provider's own state (never the payments database). Refuses to work in production. */
  SANDBOX_PSP?: DurableObjectNamespace<SandboxPsp>;
  /** POST /webhooks/:provider, by provider and source IP. */
  RL_WEBHOOK?: RateLimit;
  /** Payment emails (EmailOutbox) go through apps/edge/src/mail like account email; blank = not delivered. */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_REPLY_TO?: string;
}
