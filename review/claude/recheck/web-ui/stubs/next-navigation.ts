// Test double for next/navigation.
export function useParams() { return (globalThis as any).__params ?? {}; }
export function useRouter() {
  const pushes = ((globalThis as any).__routerPushes ??= []);
  return { push: (url: string) => pushes.push(url), replace: (url: string) => pushes.push(url), back() {}, forward() {}, refresh() {}, prefetch() {} };
}
export function usePathname() { return (globalThis as any).__pathname ?? "/"; }
export function useSearchParams() { return new URLSearchParams(); }
