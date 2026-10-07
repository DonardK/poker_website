// Test double for framer-motion in the client harness: motion.<tag> renders the plain element
// (motion-only props dropped); useReducedMotion returns globalThis.__reducedMotion.
import { createElement, forwardRef } from "react";
const MOTION_PROPS = new Set(["initial", "animate", "exit", "transition", "variants", "whileHover", "whileTap", "whileFocus", "layout", "layoutId", "onAnimationComplete"]);
const cache = new Map<string, unknown>();
export const motion: any = new Proxy({}, {
  get(_t, tag: string) {
    if (!cache.has(tag)) {
      cache.set(tag, forwardRef((props: any, ref) => {
        const clean: any = {};
        for (const [k, v] of Object.entries(props)) if (!MOTION_PROPS.has(k)) clean[k] = v;
        return createElement(tag, { ...clean, ref });
      }));
    }
    return cache.get(tag);
  },
});
export function useReducedMotion() { return Boolean((globalThis as any).__reducedMotion); }
export function AnimatePresence({ children }: any) { return children; }
