"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AuthResponse } from "@poker/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/session";

export default function LoginPage() {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function switchMode(next: "login" | "register") {
    setMode(next);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body =
        mode === "login" ? { username, password } : { username, email, password };
      const data = await api<AuthResponse>(path, { method: "POST", body: JSON.stringify(body) });
      setSession(data.user, data.accessToken);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <Link href="/" className="text-sm text-amber-200/80">
        ← Lobby
      </Link>
      <h1 className="mt-4 font-[family-name:var(--font-display)] text-4xl">Table access</h1>
      <div className="mt-6 flex gap-3">
        <button
          className={mode === "login" ? "text-amber-200" : "text-emerald-100/50"}
          onClick={() => switchMode("login")}
        >
          Login
        </button>
        <button
          className={mode === "register" ? "text-amber-200" : "text-emerald-100/50"}
          onClick={() => switchMode("register")}
        >
          Register
        </button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="mt-6 flex flex-col gap-3">
        <input
          className="rounded-xl border border-white/15 bg-black/30 px-4 py-3"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        {mode === "register" ? (
          <input
            className="rounded-xl border border-white/15 bg-black/30 px-4 py-3"
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        ) : null}
        <input
          className="rounded-xl border border-white/15 bg-black/30 px-4 py-3"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? <p className="text-red-200">{error}</p> : null}
        <button
          disabled={busy}
          className="rounded-full bg-amber-300 py-3 font-semibold text-emerald-950 disabled:opacity-50"
        >
          Continue
        </button>
      </form>
    </main>
  );
}
