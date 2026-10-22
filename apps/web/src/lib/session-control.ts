/**
 * The session hydrator's controls, for code that is not inside it: the
 * "Try again" button of the service-unavailable screen and authedApi's
 * refresh after a 401. The hydrator registers on mount; without it (server
 * render, unit tests) the calls resolve and do nothing.
 */
export interface SessionControl {
  /** Refresh the session now, through the hydrator (single flight, cross-tab lock, 401 re-check, socket renewal). */
  refresh: () => Promise<void>;
}

let control: SessionControl | null = null;

export function registerSessionControl(next: SessionControl): () => void {
  control = next;
  return () => { if (control === next) control = null; };
}

export function refreshSessionNow(): Promise<void> {
  return control ? control.refresh() : Promise.resolve();
}

export function hasSessionControl(): boolean {
  return control !== null;
}
