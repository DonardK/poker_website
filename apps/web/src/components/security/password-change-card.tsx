"use client";

import { useRef, useState } from "react";
import { PasswordField } from "@/components/auth/password-field";
import { isStepUpCancelled, useStepUp } from "@/components/auth/step-up";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { ApiError } from "@/lib/api";
import { changePassword, errorCode, messageOf, retryAfterSeconds } from "@/lib/auth-api";
import { focusSoon } from "@/lib/focus";
import { loadedStrengthEstimator, MIN_ACCEPTED_SCORE, passwordRuleProblem } from "@/lib/password-strength";
import { formatDate } from "@/lib/relative-time";
import { useAuthStore } from "@/stores/session";

/**
 * Change the password. Two requests, so each does at most one password hash
 * (the Workers CPU budget): the current password is checked first as a
 * step-up (plus the second factor when two-step verification is on), then the
 * new one is set. The other sessions are signed out; this one stays.
 */
export function PasswordChangeCard({ passwordChangedAt }: { passwordChangedAt: string | null }) {
  const { withStepUp, stepUpWithPassword } = useStepUp();
  const username = useAuthStore((s) => s.user?.username ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setDone(null);
    const problems: { current?: string; next?: string } = {};
    if (!current) problems.current = "Enter your current password.";
    const rule = passwordRuleProblem(next, username);
    if (rule) problems.next = rule;
    else if (next === current) problems.next = "Choose a password different from your current one.";
    else {
      const estimate = loadedStrengthEstimator();
      if (estimate && estimate(next, [username, "holdem", "poker"]).score < MIN_ACCEPTED_SCORE) {
        problems.next = "This password is too easy to guess. Add another word or two.";
      }
    }
    setErrors(problems);
    if (problems.current) { currentRef.current?.focus(); return; }
    if (problems.next) { nextRef.current?.focus(); return; }

    setBusy(true);
    try {
      await stepUpWithPassword(current, { action: "change your password" });
      const result = await withStepUp(() => changePassword(next), { action: "change your password" });
      setCurrent("");
      setNext("");
      const others = result?.revokedSessions ?? 0;
      setDone(others > 0
        ? `Password changed. We signed you out on your other devices (${others} ${others === 1 ? "session" : "sessions"}).`
        : "Password changed. We signed you out on your other devices.");
    } catch (err) {
      if (isStepUpCancelled(err)) return;
      const wait = retryAfterSeconds(err);
      const code = errorCode(err);
      if (err instanceof ApiError && err.status === 401 && !code) {
        // A wrong current password never signs anyone out.
        setCurrent("");
        setErrors({ current: "That password isn't right." });
        focusSoon(currentRef);
      } else if (code === "PASSWORD_BREACHED") {
        setErrors({ next: "This password has appeared in a data breach. Choose a different one." });
        focusSoon(nextRef);
      } else if (code === "PASSWORD_WEAK") {
        setErrors({ next: messageOf(err) });
        focusSoon(nextRef);
      } else if (wait !== null) setError(`Too many attempts. Try again in ${wait} s.`);
      else setError(messageOf(err, "Your password could not be changed. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="password" title="Password"
      description={passwordChangedAt ? `Last changed ${formatDate(passwordChangedAt)}.` : "Use a long password you don't use anywhere else."}>
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" aria-label="Change password">
        <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
        <PasswordField ref={currentRef} id="current-password" label="Current password" autoComplete="current-password"
          value={current} onChange={setCurrent} error={errors.current} disabled={busy} />
        <PasswordField ref={nextRef} id="change-new-password" label="New password" autoComplete="new-password"
          value={next} onChange={setNext} error={errors.next} disabled={busy} withStrength userInputs={[username, "holdem", "poker"]} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        <Button type="submit" className="self-start" busy={busy} disabled={busy}>Change password</Button>
      </form>
    </Card>
  );
}
