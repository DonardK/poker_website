// Test double for next/link: a plain anchor.
import { createElement } from "react";
export default function Link({ href, children, prefetch: _p, replace: _r, scroll: _s, ...rest }: any) {
  return createElement("a", { href: typeof href === "string" ? href : String(href?.pathname ?? ""), ...rest }, children);
}
