/** A titled section of an account page: the heading names the region for screen readers. */
export function Card({ id, title, description, action, children, className = "" }: {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Shown beside the title (e.g. a status badge). */
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`scroll-mt-24 rounded-2xl border border-white/15 bg-black/30 p-5 sm:p-6 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="font-[family-name:var(--font-display)] text-2xl font-semibold">{title}</h2>
          {description ? <div className="mt-1 text-sm text-emerald-50">{description}</div> : null}
        </div>
        {action}
      </div>
      {children ? <div className="mt-4 flex flex-col gap-4">{children}</div> : null}
    </section>
  );
}
