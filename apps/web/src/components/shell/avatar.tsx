/** The player's colour disc with their initials, as at the table (seat-hud.tsx). Decorative: the name is always next to it. */
export function Avatar({ username, hue, size = "md" }: { username: string; hue: number; size?: "sm" | "md" | "lg" }) {
  const dims = size === "lg" ? "h-12 w-12 text-base" : size === "sm" ? "h-7 w-7 text-[11px]" : "h-9 w-9 text-xs";
  return (
    <span aria-hidden="true" className={`grid shrink-0 place-items-center rounded-full font-bold text-black ${dims}`}
      style={{ background: `hsl(${Number.isFinite(hue) ? hue : 0} 70% 60%)` }}>
      {username.slice(0, 2).toUpperCase()}
    </span>
  );
}
