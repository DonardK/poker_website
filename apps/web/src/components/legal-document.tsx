import { DraftBanner } from "@/components/draft-banner";
import { BackHomeLink } from "@/components/shell/back-home-link";
import { TERMS_EFFECTIVE_DATE, TERMS_VERSION } from "@/lib/legal";

export interface LegalSection {
  id: string;
  heading: string;
  body: React.ReactNode;
}

/**
 * Shared frame of the legal documents: draft banner, version and date, a
 * table of contents and numbered sections. Text colours stay at or above
 * WCAG AA contrast (4.5:1) on the felt background.
 */
export function LegalDocument({ title, summary, sections }: { title: string; summary: React.ReactNode; sections: readonly LegalSection[] }) {
  return (
    <main id="main-content" className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-8 sm:py-12">
      <BackHomeLink />
      <DraftBanner />
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
        <p className="mt-2 text-sm text-emerald-50">Version {TERMS_VERSION} · effective {TERMS_EFFECTIVE_DATE}</p>
        <div className="mt-4 text-emerald-50">{summary}</div>
      </header>
      <nav aria-label="Contents" className="rounded-2xl border border-white/15 bg-black/30 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-100">Contents</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
          {sections.map((section) => (
            <li key={section.id}><a href={`#${section.id}`} className="underline decoration-white/40 underline-offset-4 hover:decoration-amber-200">{section.heading}</a></li>
          ))}
        </ol>
      </nav>
      <div className="flex flex-col gap-8">
        {sections.map((section, index) => (
          <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`} className="scroll-mt-6">
            <h2 id={`${section.id}-heading`} className="font-[family-name:var(--font-display)] text-2xl font-semibold">
              {index + 1}. {section.heading}
            </h2>
            <div className="mt-3 flex flex-col gap-3 leading-relaxed text-emerald-50">{section.body}</div>
          </section>
        ))}
      </div>
    </main>
  );
}

/** Placeholder for operator details that only counsel / the licence can supply; rendered so it cannot be mistaken for final text. */
export function Placeholder({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-amber-950 px-1.5 py-0.5 font-mono text-[0.85em] text-amber-100">[{children}]</span>;
}

/** A passage flagged for counsel review (privacy basis, retention, etc.). */
export function CounselNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-amber-300/60 bg-amber-950/60 px-4 py-2 text-sm text-amber-50">
      <span className="font-semibold">For counsel review: </span>{children}
    </p>
  );
}

/** A bulleted list (Tailwind's preflight removes list markers, so they are restored here). */
export function Bullets({ items }: { items: readonly React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-6 marker:text-amber-200">
      {items.map((item, index) => <li key={index}>{item}</li>)}
    </ul>
  );
}
