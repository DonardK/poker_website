import Link from "next/link";
import type { AccountSecurity } from "@poker/shared";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CheckIcon, CloseIcon } from "@/components/ui/icons";

interface Item {
  label: string;
  done: boolean;
  /** Where to fix it on this page or the account page. */
  href: string;
  hint: string;
}

/** A checklist of the account's protections and an overall status. */
export function SecurityOverview({ security }: { security: AccountSecurity }) {
  const secondFactor = security.totp.enabled || security.passkeys.length > 0;
  const items: Item[] = [
    { label: "Email confirmed", done: security.emailVerified, href: "/account#email", hint: "Needed for sign-in alerts and recovery." },
    { label: "Password set", done: true, href: "#password", hint: "" },
    { label: "Two-step verification", done: security.totp.enabled, href: "#two-step", hint: "Codes from an authenticator app." },
    { label: "Passkey", done: security.passkeys.length > 0, href: "#passkeys", hint: "Fingerprint, face or screen lock." },
  ];
  const status = security.emailVerified && secondFactor ? "Strong" : security.emailVerified || secondFactor ? "Good" : "Needs attention";
  return (
    <Card id="overview" title="Your protection" action={<Badge tone={status === "Strong" ? "success" : "warning"}>{status}</Badge>}
      description={status === "Strong"
        ? "Your account has a second way to prove it's you."
        : "Add a passkey or two-step verification so a stolen password is not enough to get in."}>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.label} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
            {item.done
              ? <CheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-emerald-200" />
              : <CloseIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />}
            <span className="min-w-0">
              <span className="block font-semibold text-emerald-50">
                {item.label}<span className="sr-only">{item.done ? ": done" : ": not yet"}</span>
              </span>
              {!item.done ? (
                <Link href={item.href} className="text-sm text-amber-100 underline underline-offset-4">Set it up</Link>
              ) : item.hint ? <span className="block text-xs text-emerald-50/90">{item.hint}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
