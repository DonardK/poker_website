"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AuthResponse } from "@poker/shared";
import { AgeTermsGate, hasConsent, NO_CONSENT, type AgeTermsConsent } from "@/components/age-terms-gate";
import { TurnstileWidget, turnstileTokenField } from "@/components/turnstile-widget";
import { api } from "@/lib/api";
import { PLAY_CHIPS_NOTICE, PLAY_MONEY_NOTICE, termsAcceptance, termsErrorMessage } from "@/lib/legal";
import { useAuthStore } from "@/stores/session";

export default function LoginPage() {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState<AgeTermsConsent>(NO_CONSENT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const registering = mode === "register";

  function switchMode(next: "login" | "register") {
    setMode(next);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Registration creates an account: never without the 18+ confirmation and terms acceptance.
    if (registering && !hasConsent(consent)) return;
    setBusy(true);
    setError(null);
    try {
      const path = registering ? "/api/auth/register" : "/api/auth/login";
      const turnstile = turnstileTokenField(turnstileToken);
      const body = registering
        ? { username, email, password, ...termsAcceptance(), ...turnstile }
        : { username, password, ...turnstile };
      const data = await api<AuthResponse>(path, { method: "POST", body: JSON.stringify(body) });
      setSession(data.user, data.accessToken);
      router.push("/");
    } catch (err) {
      const termsMessage = registering ? termsErrorMessage(err) : null;
      setError(termsMessage ?? (err instanceof Error ? err.message : "Sign-in failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <Link href="/" className="text-sm text-amber-100 underline-offset-4 hover:underline">
        ← Lobby
      </Link>
      <h1 className="mt-4 font-[family-name:var(--font-display)] text-4xl">Table access</h1>
      <p className="mt-2 text-sm text-emerald-50">Your seat, play-chip balance and hands stay with your account.</p>
      <p className="mt-2 text-sm text-emerald-50">{PLAY_MONEY_NOTICE}. {PLAY_CHIPS_NOTICE}</p>
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          aria-pressed={mode === "login"}
          className={mode === "login" ? "font-semibold text-amber-200 underline underline-offset-4" : "text-emerald-50/90"}
          onClick={() => switchMode("login")}
        >
          Login
        </button>
        <button
          type="button"
          aria-pressed={registering}
          className={registering ? "font-semibold text-amber-200 underline underline-offset-4" : "text-emerald-50/90"}
          onClick={() => switchMode("register")}
        >
          Register
        </button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="mt-6 flex flex-col gap-3">
        <label htmlFor="username" className="text-sm text-emerald-50">Username</label>
        <input
          id="username"
          autoComplete="username"
          required
          className="rounded-xl border border-white/25 bg-black/30 px-4 py-3"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        {registering ? (
          <div className="flex flex-col gap-3">
            <label htmlFor="email" className="text-sm text-emerald-50">Email</label>
            <input
              id="email"
              autoComplete="email"
              required
              className="rounded-xl border border-white/25 bg-black/30 px-4 py-3"
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        ) : null}
        <label htmlFor="password" className="text-sm text-emerald-50">Password</label>
        <input
          id="password"
          autoComplete={registering ? "new-password" : "current-password"}
          className="rounded-xl border border-white/25 bg-black/30 px-4 py-3"
          placeholder={registering ? "Password (12–72 characters)" : "Password"}
          minLength={registering ? 12 : undefined}
          maxLength={72}
          required
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {registering ? <AgeTermsGate value={consent} onChange={setConsent} disabled={busy} /> : null}
        <TurnstileWidget onToken={setTurnstileToken} />
        {error ? <p role="alert" className="rounded-xl border border-red-400/50 bg-red-950/60 px-4 py-2 text-red-100">{error}</p> : null}
        <button
          disabled={busy || (registering && !hasConsent(consent))}
          className="rounded-full bg-amber-300 py-3 font-semibold text-emerald-950 disabled:opacity-50"
        >
          {registering ? "Create account" : "Continue"}
        </button>
      </form>
    </main>
  );
}
