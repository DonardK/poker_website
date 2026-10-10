"use client";

import { useEffect, useState } from "react";
import { verifyParticipantAudit, type ParticipantHandAudit, type PublicTableState } from "@poker/shared";
import { api } from "@/lib/api";
import { liveEvidenceKey, readLiveEvidence, type LiveHandEvidence } from "@/hooks/use-table-socket";
import { useAuthStore } from "@/stores/session";

/**
 * Post-hand verification for a participant. The server returns only the
 * redacted audit: the hash-chained action log plus Merkle openings for this
 * player's own hole cards, the board and hands tabled at showdown. The
 * browser recomputes every hash and checks the openings against the record's
 * Merkle deck root. When this browser recorded the hand live, it also
 * compares the record with the commitments, audit-chain head and hole-card
 * digest it saw then.
 */
export function FairnessAudit({ tableId, accessToken, snapshot, className = "flex flex-col items-start gap-1", closed = false }: {
  tableId: string;
  accessToken: string;
  snapshot: PublicTableState;
  className?: string;
  /**
   * The table has closed, so every hand it dealt has settled. `snapshot` may
   * predate the closure (missed while reconnecting), so its hand number is a
   * default, not a limit: a later hand can be chosen and the server decides
   * (a hand that does not exist, or that this player was not dealt into, is
   * refused like any other).
   */
  closed?: boolean;
}) {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const latestHand = auditableHand(snapshot, closed);
  const [selectedHand, setSelectedHand] = useState(String(latestHand));
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ hand: number; message: string; valid: boolean } | null>(null);
  useEffect(() => { setSelectedHand(String(latestHand)); setResult(null); }, [latestHand]);
  if (latestHand < 1) return null;

  const check = async () => {
    const handNumber = Number(selectedHand);
    if (!Number.isSafeInteger(handNumber) || handNumber < 1 || (!closed && handNumber > latestHand)) {
      setResult({ hand: 0, valid: false, message: closed ? "Choose a hand number of 1 or more." : `Choose a hand from 1 to ${latestHand}.` });
      return;
    }
    if (!userId) {
      setResult({ hand: 0, valid: false, message: "Sign in to verify a hand." });
      return;
    }
    setChecking(true);
    try {
      const { audit } = await api<{ audit: ParticipantHandAudit }>(`/api/tables/${encodeURIComponent(tableId)}/hands/${handNumber}/audit`, { token: accessToken });
      const evidence = readLiveEvidence(liveEvidenceKey(userId, tableId, handNumber));
      // COMPLIANCE NOTE: the expected table, hand number and player come from
      // this request and the signed-in session, never from storage or the
      // server's response. An audit of another table or hand, or of another
      // player's seat, fails.
      const verdict = await verifyParticipantAudit(audit, { ...evidence, tableId, handNumber, userId });
      setResult({
        hand: handNumber,
        valid: verdict.ok,
        message: verdict.ok
          ? successMessage(evidence)
          : `Verification failed: ${verdict.reason ?? "unknown reason"}. Stop playing and save this hand number.`,
      });
    } catch (error) {
      setResult({ hand: handNumber, valid: false, message: error instanceof Error ? error.message : "Could not verify this hand." });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className={className}>
      <label className="flex items-center gap-2 text-xs text-emerald-50">
        Hand
        <input type="number" min={1} max={closed ? undefined : latestHand} value={selectedHand}
          onChange={(event) => { setSelectedHand(event.target.value); setResult(null); }}
          className="w-16 rounded-lg border border-white/20 bg-black/20 px-2 py-1 text-sm text-white" />
      </label>
      <button type="button" onClick={() => void check()} disabled={checking}
        className="min-h-10 rounded-full border border-emerald-200/60 px-4 py-2 text-sm transition hover:bg-white/10 disabled:opacity-60">
        {checking ? "Verifying…" : "Verify hand"}
      </button>
      {result && (result.hand === Number(selectedHand) || result.hand === 0) ?
        <span role="status" className={`max-w-64 text-xs ${result.valid ? "text-emerald-200" : "text-red-200"}`}>{result.message}</span> : null}
    </div>
  );
}

/**
 * The latest hand that has finished (and so has an audit) in this snapshot;
 * below 1 when none has. At a closed table the hand in progress has settled:
 * closure finishes it before the table closes, even when this snapshot was
 * taken mid-hand.
 */
export function auditableHand(snapshot: PublicTableState, closed = false): number {
  const active = ["PREFLOP", "FLOP", "TURN", "RIVER"].includes(snapshot.phase);
  return snapshot.handNumber - (active && !closed ? 1 : 0);
}

/**
 * Claim exactly what verifyParticipantAudit proved. A participant never
 * receives the deck or salts, so the SHA-256 deck commitment can only be
 * compared with the value seen live, never recomputed.
 */
function successMessage(evidence: LiveHandEvidence | null): string {
  if (!evidence) {
    return "The record is internally consistent and every card you could see matches its Merkle deck commitment, " +
      "but this browser has no live record of this hand to compare it against.";
  }
  return evidence.holeCardsDigest !== undefined
    ? "The record matches the pre-deal deck commitment, your hole cards and the audit chain this browser saw live. " +
      "The board and the hash-chained action log verify."
    : "The record matches the pre-deal deck commitment and the audit chain this browser saw live. " +
      "The board and the hash-chained action log verify. This browser did not record your hole cards for this hand.";
}
