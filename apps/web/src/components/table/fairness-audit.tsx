"use client";

import { useEffect, useState } from "react";
import { verifyParticipantAudit, type ParticipantHandAudit, type PublicTableState } from "@poker/shared";
import { api } from "@/lib/api";
import { liveEvidenceKey, readLiveEvidence } from "@/hooks/use-table-socket";

/**
 * Post-hand verification for a participant. The server returns only the
 * redacted audit: the hash-chained action log plus Merkle openings for this
 * player's own hole cards, the board and hands tabled at showdown. The
 * browser recomputes every hash. It checks the openings against the
 * pre-deal commitment and compares the record with the commitments, chain
 * head and hole cards it saw during live play.
 */
export function FairnessAudit({ tableId, accessToken, snapshot }: {
  tableId: string;
  accessToken: string;
  snapshot: PublicTableState;
}) {
  const active = ["PREFLOP", "FLOP", "TURN", "RIVER"].includes(snapshot.phase);
  const latestHand = snapshot.handNumber - (active ? 1 : 0);
  const [selectedHand, setSelectedHand] = useState(String(latestHand));
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ hand: number; message: string; valid: boolean } | null>(null);
  useEffect(() => { setSelectedHand(String(latestHand)); setResult(null); }, [latestHand]);
  if (latestHand < 1) return null;

  const check = async () => {
    const handNumber = Number(selectedHand);
    if (!Number.isSafeInteger(handNumber) || handNumber < 1 || handNumber > latestHand) {
      setResult({ hand: 0, valid: false, message: `Choose a hand from 1 to ${latestHand}.` });
      return;
    }
    setChecking(true);
    try {
      const { audit } = await api<{ audit: ParticipantHandAudit }>(`/api/tables/${encodeURIComponent(tableId)}/hands/${handNumber}/audit`, { token: accessToken });
      const observed = readLiveEvidence(liveEvidenceKey(tableId, handNumber));
      const verdict = await verifyParticipantAudit(audit, observed ?? {});
      setResult({
        hand: handNumber,
        valid: verdict.ok,
        message: verdict.ok
          ? observed
            ? "Deck commitment, your cards, the board and the full action log verified against what you saw live."
            : "Deck commitment, cards and action log verified. This browser did not record this hand live."
          : `Verification failed: ${verdict.reason ?? "unknown reason"}. Stop playing and save this hand number.`,
      });
    } catch (error) {
      setResult({ hand: handNumber, valid: false, message: error instanceof Error ? error.message : "Could not verify this hand." });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <label className="flex items-center gap-2 text-xs text-emerald-100/80">
        Hand
        <input type="number" min={1} max={latestHand} value={selectedHand}
          onChange={(event) => { setSelectedHand(event.target.value); setResult(null); }}
          className="w-16 rounded-lg border border-white/20 bg-black/20 px-2 py-1 text-sm text-white" />
      </label>
      <button type="button" onClick={() => void check()} disabled={checking}
        className="min-h-10 rounded-full border border-emerald-200/40 px-4 py-2 text-sm transition hover:bg-white/10 disabled:opacity-60">
        {checking ? "Verifying…" : "Verify hand"}
      </button>
      {result && (result.hand === Number(selectedHand) || result.hand === 0) ?
        <span role="status" className={`max-w-64 text-xs ${result.valid ? "text-emerald-200" : "text-red-200"}`}>{result.message}</span> : null}
    </div>
  );
}
