"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { errorCode, messageOf, resendVerification, retryAfterSeconds } from "@/lib/auth-api";
import { useAuthStore } from "@/stores/session";

/** After a resend, the button waits this long (the API also rate-limits). */
const COOLDOWN_S = 60;

/**
 * POST /api/account/email/verification with a cooldown countdown. The
 * countdown text updates every second on the button; the status message is
 * set once per send, so screen readers are not flooded.
 */
export function useResendVerification(): { send: () => Promise<void>; busy: boolean; cooldown: number; message: string } {
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (until <= Date.now()) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [until]);

  const send = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      await resendVerification();
      setMessage("Sent. Check your inbox (and spam folder).");
      setUntil(Date.now() + COOLDOWN_S * 1000);
      setNow(Date.now());
    } catch (err) {
      const wait = retryAfterSeconds(err, COOLDOWN_S);
      if (wait !== null) {
        setUntil(Date.now() + wait * 1000);
        setNow(Date.now());
        setMessage("Please wait a moment before asking again.");
      } else if (errorCode(err) === "EMAIL_ALREADY_VERIFIED") {
        useAuthStore.getState().patchUser({ emailVerified: true });
        setMessage("Your email is already confirmed.");
      } else if (errorCode(err) === "MAIL_UNAVAILABLE") {
        setMessage("We can't send email right now. Try again later.");
      } else if (errorCode(err) === "EMAIL_MISSING") {
        setMessage("Add an email address first.");
      } else {
        setMessage(err instanceof ApiError ? messageOf(err) : "Could not send the email. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }, []);

  return { send, busy, cooldown: Math.max(0, Math.ceil((until - now) / 1000)), message };
}
