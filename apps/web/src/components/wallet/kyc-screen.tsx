"use client";

import { useEffect, useState } from "react";
import type { KycStatus } from "@poker/shared";
import { Button, buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { leaveWithFullPageLoads, loadSumsubSdk, reloadUnlessLoadedHere } from "@/components/wallet/kyc-sdk";
import { usePoll } from "@/components/wallet/use-poll";
import { BackToWallet, liveRealMoney, useWallet, WalletOffCard } from "@/components/wallet/wallet-frame";
import { safeProviderUrl, startKyc } from "@/lib/wallet-api";
import { walletErrorMessage } from "@/lib/wallet-copy";

type Phase = "idle" | "starting" | "sdk" | "submitted" | "leaving" | "waiting";

const SDK_CONTAINER = "kyc-sdk-container";

function sdkErrorMessage(payload: unknown): string {
  const code = typeof payload === "object" && payload !== null ? (payload as { code?: unknown }).code : undefined;
  switch (code) {
    case "camera-error": return "We couldn't use your camera. Allow camera access for this site in your browser settings, then start again.";
    case "invalid-token": return "Your verification session expired. Start again.";
    case "invalid-origin": return "Verification isn't available on this website address yet. Contact support.";
    default: return "Verification couldn't continue. Try again later.";
  }
}

/**
 * /wallet/verify: identity verification (KYC). The API's session decides
 * how: a hosted page (`url`: the sandbox provider, or a provider link) is a
 * full-page redirect; a Sumsub token runs Sumsub's WebSDK in this page. Only
 * this page's policy allows that provider (middleware.ts, next.config.ts),
 * so it is always loaded, and left, with a full page load. The outcome is
 * never taken from the SDK: the page re-reads the wallet summary, which
 * changes only when the provider's signed result reached the payments Worker.
 */
export function KycScreen() {
  const { summary, reload } = useWallet();
  const money = liveRealMoney(summary);
  const status: KycStatus | null = money?.kyc.status ?? null;
  const [reloading, setReloading] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (reloadUnlessLoadedHere()) return;
    setReloading(false);
    return leaveWithFullPageLoads();
  }, []);

  useEffect(() => {
    if (phase !== "sdk" || !token) return;
    let live = true;
    void loadSumsubSdk().then((sdk) => {
      if (!live) return;
      sdk.init(token, async () => (await startKyc()).sdkToken)
        .withConf({ lang: "en", theme: "dark" })
        .withOptions({ addViewportTag: false, adaptIframeHeight: true })
        .on("idCheck.onError", (payload) => { if (live) setError(sdkErrorMessage(payload)); })
        .onMessage((type) => {
          if (!live) return;
          if (/onApplicant(Re)?[Ss]ubmitted$/.test(type)) setPhase("submitted");
          if (/onApplicantStatusChanged$|applicantStatus$/.test(type)) void reload();
        })
        .build()
        .launch(`#${SDK_CONTAINER}`);
    }).catch(() => {
      if (!live) return;
      setError("The verification service didn't load. Check your connection, or turn off any blocker for this page, then try again.");
      setPhase("idle");
    });
    return () => { live = false; };
  }, [phase, token, reload]);

  const waiting = phase === "submitted" || phase === "waiting" || status === "PENDING";
  const { timedOut } = usePoll(reload, {
    active: Boolean(money) && waiting && status !== "VERIFIED" && status !== "REJECTED",
    intervalMs: 5_000, maxIntervalMs: 15_000, maxDurationMs: 3 * 60_000,
  });

  async function start() {
    if (phase === "starting") return;
    setPhase("starting");
    setError(null);
    try {
      const session = await startKyc();
      if (session.url) {
        const target = safeProviderUrl(session.url);
        if (!target) throw new Error("unsafe");
        setPhase("leaving");
        window.location.assign(target);
      } else if (/sumsub/i.test(session.provider) && session.sdkToken) {
        setToken(session.sdkToken);
        setPhase("sdk");
      } else {
        // A provider with nothing to show (the built-in sandbox decides on its own): wait for the result.
        setPhase("waiting");
        void reload();
      }
    } catch (err) {
      setError(err instanceof Error && err.message === "unsafe" ? "The verification page address wasn't safe to open, so we stopped." : walletErrorMessage(err));
      setPhase("idle");
    }
  }

  if (reloading) {
    return <p role="status" className="flex items-center gap-2 text-emerald-50"><Spinner className="h-5 w-5" /> Opening verification…</p>;
  }

  return (
    <>
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold">Verify your identity</h1>
        <p className="mt-2 text-emerald-50">We&apos;re required to check who you are before you deposit or withdraw.</p>
      </header>
      {!money ? <WalletOffCard /> : status === "VERIFIED" ? (
        <Card id="kyc-result" title="You're verified">
          <Notice tone="success">Your identity is confirmed. Deposits and withdrawals are open to you.</Notice>
          <a href="/wallet" className={buttonClass("primary", "self-start")}>Go to your wallet</a>
        </Card>
      ) : status === "REJECTED" ? (
        <Card id="kyc-result" title="We couldn't verify your identity">
          <p className="text-emerald-50">
            Deposits and withdrawals stay closed. If you think this is a mistake, <a href="/complaints" className="text-amber-100 underline underline-offset-4">contact
            us through our complaints process</a>.
          </p>
        </Card>
      ) : waiting && phase !== "sdk" && phase !== "submitted" ? (
        <Card id="kyc-result" title="We're checking your documents">
          <p role="status" className="text-emerald-50">
            {timedOut ? "This is taking longer than usual. You can leave this page: we'll email you when it's done."
              : "This usually takes a few minutes. You can leave this page: we'll email you when it's done."}
          </p>
        </Card>
      ) : (
        <Card id="kyc-start" title="Start verification">
          {phase === "sdk" || phase === "submitted" ? (
            <>
              {phase === "submitted" ? <Notice tone="success">Thanks. We&apos;re checking your documents; this usually takes a few minutes.</Notice> : null}
              <div id={SDK_CONTAINER} className="min-h-[28rem] overflow-hidden rounded-xl bg-black/20" />
            </>
          ) : (
            <>
              <ul className="list-disc space-y-1 pl-5 text-emerald-50">
                <li>Have an identity document ready: a passport, ID card or driving licence.</li>
                <li>Use a device with a camera; your browser will ask before the camera turns on.</li>
                <li>Our identity-verification provider checks the document and a short selfie video. See our <a href="/privacy" className="text-amber-100 underline underline-offset-4">Privacy Notice</a>.</li>
              </ul>
              {summary.mode === "sandbox" ? <p className="text-sm text-emerald-50/90">Sandbox: the test verification needs no documents.</p> : null}
              <Button className="self-start" busy={phase === "starting" || phase === "leaving"} disabled={phase === "starting" || phase === "leaving"}
                onClick={() => void start()}>
                Start verification
              </Button>
            </>
          )}
          {error ? <Notice tone="error">{error}</Notice> : null}
        </Card>
      )}
      <BackToWallet fullPage />
    </>
  );
}

/** /wallet/verify/return: back from a hosted verification page; the result is read from the API, never the URL. */
export function KycReturnScreen() {
  const { summary, reload } = useWallet();
  const money = liveRealMoney(summary);
  const status = money?.kyc.status ?? null;
  useEffect(() => { void reload(); }, [reload]);
  const settled = status === "VERIFIED" || status === "REJECTED";
  const { timedOut } = usePoll(reload, { active: Boolean(money) && !settled, intervalMs: 3_000, maxIntervalMs: 10_000, maxDurationMs: 60_000 });
  return (
    <>
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold">Identity verification</h1>
      </header>
      {!money ? <WalletOffCard /> : (
        <Card id="kyc-result" title={status === "VERIFIED" ? "You're verified" : status === "REJECTED" ? "We couldn't verify your identity" : "We're checking your documents"}>
          <p role="status" className="text-emerald-50">
            {status === "VERIFIED" ? "Your identity is confirmed. Deposits and withdrawals are open to you."
              : status === "REJECTED" ? "Deposits and withdrawals stay closed. If you think this is a mistake, contact us through our complaints process."
                : timedOut ? "This is taking longer than usual. We'll email you when it's done."
                  : "Waiting for the result. This usually takes a few minutes."}
          </p>
        </Card>
      )}
      <BackToWallet />
    </>
  );
}
