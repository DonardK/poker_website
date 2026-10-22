"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/ui/copy-button";
import { Notice } from "@/components/ui/notice";
import { SITE_NAME } from "@/lib/site";

const FILE_NAME = "holdem-live-backup-codes.txt";

/**
 * Ten single-use backup codes, shown once (the server keeps only keyed
 * hashes). Copy, download or print them; "Done" stays disabled until the
 * person confirms they saved them somewhere safe.
 */
export function BackupCodesPanel({ codes, username, onDone, doneLabel = "Done" }: {
  codes: string[];
  username: string;
  onDone: () => void;
  doneLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const text = [
    `${SITE_NAME} backup codes for ${username}`,
    "Each code works once. Keep them somewhere safe and private.",
    "",
    ...codes,
    "",
  ].join("\n");

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = FILE_NAME;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // The codes are not left reachable through a blob: URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function print() {
    document.body.classList.add("printing-codes");
    const done = () => {
      document.body.classList.remove("printing-codes");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
    // Browsers without afterprint (or a blocked dialog) still drop the class.
    window.setTimeout(done, 1_000);
  }

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="warning" live={false}>
        Save these codes now: they are shown only once. If you lose your phone, each code signs you in one time instead of a 6-digit code.
      </Notice>
      <div data-print-area className="rounded-xl border border-white/15 bg-black/40 p-4">
        <p className="sr-only">{`${SITE_NAME} backup codes for ${username}`}</p>
        <ol aria-label="Backup codes" className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-base tracking-wider text-emerald-50">
          {codes.map((code) => <li key={code} data-testid="backup-code">{code}</li>)}
        </ol>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <CopyButton value={text} label="Copy all" />
        <Button variant="secondary" className="min-h-10 px-4 py-2 text-sm" onClick={download}>Download</Button>
        <Button variant="secondary" className="min-h-10 px-4 py-2 text-sm" onClick={print}>Print</Button>
      </div>
      <Checkbox id="backup-codes-saved" label="I've saved these codes somewhere safe" checked={saved}
        onChange={(event) => setSaved(event.target.checked)} />
      <Button onClick={onDone} disabled={!saved}>{doneLabel}</Button>
    </div>
  );
}
