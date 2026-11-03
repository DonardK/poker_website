/**
 * GET /api/wallet/transactions: the movements of the player's available
 * balance in the settlement asset, newest first, straight from the ledger
 * journal (LedgerEntry of the USER_AVAILABLE account), with the status of the
 * deposit or withdrawal behind each. Cursor = the last LedgerTransaction.seq shown.
 */
import { WALLET_PAGE_MAX, type Page, type WalletTxKind, type WalletTxView } from "@poker/shared";
import type { PageQuery } from "./contract";
import type { PaymentsContext } from "./context";
import { money } from "./views";

interface Row {
  id: string;
  seq: string;
  type: string;
  amount: string;
  balanceAfter: string;
  createdAt: Date;
  depositId: string | null;
  withdrawalId: string | null;
  reversalId: string | null;
  depositStatus: string | null;
  withdrawalStatus: string | null;
  withdrawalKind: string | null;
}

function kindOf(row: Row): WalletTxKind {
  switch (row.type) {
    case "DEPOSIT_CREDIT": return "DEPOSIT";
    case "WITHDRAWAL_HOLD": return row.withdrawalKind === "REFUND" ? "REFUND" : "WITHDRAWAL";
    case "WITHDRAWAL_RELEASE": return "WITHDRAWAL_RELEASED";
    case "WITHDRAWAL_RETURN": return "PAYOUT_RETURNED";
    case "DEPOSIT_REVERSAL": return "REVERSAL";
    case "CHARGEBACK_RECOVERY": return "RECOVERY";
    default: return "ADJUSTMENT";
  }
}

export async function listTransactions(ctx: PaymentsContext, userId: string, query: PageQuery): Promise<Page<WalletTxView>> {
  const limit = Math.min(Math.max(Math.trunc(Number(query?.limit ?? 20)) || 20, 1), WALLET_PAGE_MAX);
  const before = typeof query?.cursor === "string" && /^\d{1,19}$/.test(query.cursor) ? query.cursor : null;
  const rows = await ctx.db.$queryRaw<Row[]>`
    SELECT t."id"::text AS id, t."seq"::text AS seq, t."type"::text AS type, e."amount"::text AS amount, e."balanceAfter"::text AS "balanceAfter",
           t."createdAt", t."reference"->>'depositId' AS "depositId", t."reference"->>'withdrawalId' AS "withdrawalId",
           t."reference"->>'reversalId' AS "reversalId", d."status"::text AS "depositStatus", w."status"::text AS "withdrawalStatus", w."kind"::text AS "withdrawalKind"
      FROM public."LedgerEntry" e
      JOIN public."LedgerAccount" a ON a."id" = e."accountId"
      JOIN public."LedgerTransaction" t ON t."id" = e."transactionId"
      LEFT JOIN public."Deposit" d ON d."id"::text = t."reference"->>'depositId'
      LEFT JOIN public."Withdrawal" w ON w."id"::text = t."reference"->>'withdrawalId'
     WHERE a."userId" = ${userId} AND a."assetCode" = ${ctx.config.settlementAsset} AND a."type" = 'USER_AVAILABLE'
       AND (${before}::bigint IS NULL OR t."seq" < ${before}::bigint)
     ORDER BY t."seq" DESC
     LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => {
      const ref: WalletTxView["ref"] = row.type === "DEPOSIT_REVERSAL" || row.type === "CHARGEBACK_RECOVERY"
        ? (row.reversalId ? { type: "REVERSAL", id: row.reversalId } : null)
        : row.withdrawalId ? { type: "WITHDRAWAL", id: row.withdrawalId } : row.depositId ? { type: "DEPOSIT", id: row.depositId } : null;
      return {
        id: row.id, seq: row.seq, kind: kindOf(row), amount: money(BigInt(row.amount)), balanceAfter: money(BigInt(row.balanceAfter)),
        status: row.withdrawalStatus ?? row.depositStatus, createdAt: row.createdAt.toISOString(), ref,
      };
    }),
    next: rows.length > limit && page.length > 0 ? page[page.length - 1]!.seq : null,
  };
}
