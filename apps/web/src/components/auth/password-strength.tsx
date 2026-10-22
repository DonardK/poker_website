"use client";

import { useEffect, useState } from "react";
import { PASSWORD_MIN_LENGTH } from "@poker/shared";
import { CheckIcon } from "@/components/ui/icons";
import { lengthStrength, loadStrengthEstimator, type StrengthEstimator, type Strength } from "@/lib/password-strength";

const SEGMENT = ["bg-red-400", "bg-red-400", "bg-amber-300", "bg-emerald-300", "bg-emerald-200"];

/**
 * The strength meter under a new-password field: four segments (decorative),
 * a polite live sentence debounced to 300 ms, and the two requirements. The
 * estimate never blocks typing; it guides, and the server decides.
 */
export function PasswordStrength({ id, password, userInputs }: { id: string; password: string; userInputs: string[] }) {
  const [estimator, setEstimator] = useState<StrengthEstimator | null>(null);
  const [strength, setStrength] = useState<Strength>(() => lengthStrength(password));
  const [announced, setAnnounced] = useState("");
  const inputsKey = userInputs.join("\u0000");

  // The estimator chunk loads once someone starts typing a new password (the field also warms it on focus).
  const started = password.length > 0;
  useEffect(() => {
    if (!started || estimator) return;
    let live = true;
    void loadStrengthEstimator().then((fn) => { if (live) setEstimator(() => fn); }).catch(() => undefined);
    return () => { live = false; };
  }, [started, estimator]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setStrength(estimator ? estimator(password, inputsKey ? inputsKey.split("\u0000") : []) : lengthStrength(password));
    }, 150);
    return () => window.clearTimeout(id);
  }, [password, estimator, inputsKey]);

  const sentence = password
    ? `Strength: ${strength.label}.${strength.warning ? ` ${strength.warning}` : ""}${strength.suggestions[0] ? ` ${strength.suggestions[0]}` : ""}`
    : "";
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnounced(sentence), 300);
    return () => window.clearTimeout(timer);
  }, [sentence]);

  const lit = password ? Math.max(1, strength.score) : 0;
  const longEnough = password.length >= PASSWORD_MIN_LENGTH;
  const notCommon = strength.source === "zxcvbn" ? strength.score >= 2 && !strength.warning?.includes("common") : null;
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden="true" className="grid grid-cols-4 gap-1.5">
        {[1, 2, 3, 4].map((segment) => (
          <span key={segment} className={`h-1.5 rounded-full ${segment <= lit ? SEGMENT[strength.score] : "bg-white/15"}`} />
        ))}
      </div>
      <p id={id} aria-live="polite" className="min-h-5 text-sm text-emerald-50">{announced}</p>
      <ul className="flex flex-col gap-1 text-xs text-emerald-50/90">
        <li className="flex items-center gap-2">
          <CheckIcon className={`h-4 w-4 ${longEnough ? "text-emerald-200" : "text-white/30"}`} />
          At least {PASSWORD_MIN_LENGTH} characters{longEnough ? "" : " (not yet)"}
        </li>
        <li className="flex items-center gap-2">
          <CheckIcon className={`h-4 w-4 ${notCommon ? "text-emerald-200" : "text-white/30"}`} />
          Not a common password{notCommon === false && password ? " (not yet)" : ""}
        </li>
      </ul>
    </div>
  );
}
