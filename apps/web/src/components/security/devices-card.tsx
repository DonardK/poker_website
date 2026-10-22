"use client";

import { useCallback, useEffect, useState } from "react";
import type { KnownDeviceSummary } from "@poker/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DeviceIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { fetchDevices, forgetDevice, messageOf } from "@/lib/auth-api";
import { formatRelativeTime } from "@/lib/relative-time";
import { signOut } from "@/lib/session-actions";

/**
 * Browsers this account has signed in from. A sign-in from one not on this
 * list sends an alert to the verified email. Forgetting a device signs out
 * its sessions; its next sign-in counts as new (and alerts again).
 */
export function DevicesCard() {
  const [devices, setDevices] = useState<KnownDeviceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<KnownDeviceSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices((await fetchDevices()).devices);
      setError(null);
    } catch (err) {
      setError(messageOf(err, "Your devices could not be loaded."));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function forget(device: KnownDeviceSummary) {
    setBusy(true);
    setMessage(null);
    try {
      await forgetDevice(device.id);
      setForgetting(null);
      // Forgetting this browser signs it out too (the API ends its sessions).
      if (device.current) { void signOut({ reason: "logout" }); return; }
      setMessage(`Forgot ${device.label ?? "that device"} and signed it out.`);
      await load();
    } catch (err) {
      setForgetting(null);
      setError(messageOf(err, "That device could not be forgotten."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="devices" title="Recognised devices"
      description="We email you when someone signs in from a device that isn't on this list (once your email is confirmed).">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {devices && devices.length === 0 ? <p className="text-sm text-emerald-50">No devices yet.</p> : null}
      {devices && devices.length > 0 ? (
        <ul aria-label="Recognised devices" className="flex flex-col gap-2">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-col gap-3 rounded-xl border border-white/15 bg-white/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <DeviceIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-emerald-50">
                    {device.label ?? "Unknown device"}{device.current ? <Badge tone="success">This device</Badge> : null}
                  </p>
                  <p className="text-xs text-emerald-50/90">
                    {[device.country, device.ip, `Last seen ${formatRelativeTime(device.lastSeenAt)}`].filter(Boolean).join(" · ")}
                  </p>
                </div>
              </div>
              <Button variant="secondary" className="min-h-10 shrink-0 px-4 py-2 text-sm" disabled={busy}
                onClick={() => { setMessage(null); setForgetting(device); }} aria-label={`Forget ${device.label ?? "this device"}`}>
                Forget
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {forgetting ? (
        <ConfirmDialog title="Forget this device?"
          body={forgetting.current
            ? "This browser will be signed out, and its next sign-in will count as a new device."
            : "Its sessions are signed out, and its next sign-in will count as a new device and send you an alert."}
          confirmLabel="Forget device" tone="danger" busy={busy} onConfirm={() => void forget(forgetting)} onCancel={() => setForgetting(null)} />
      ) : null}
    </Card>
  );
}
