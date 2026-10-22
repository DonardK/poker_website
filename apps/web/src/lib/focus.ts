/** How many animation frames focusSoon waits for a disabled field to be re-enabled. */
const MAX_FRAMES = 30;

/**
 * Focus an element once it can take focus. After a refused submit the field
 * is still disabled (the form is busy) when the handler runs, and a disabled
 * input cannot take focus. React re-enables it on its next render, which is
 * not always before the next frame (updates after an await are scheduled, not
 * synchronous), so this checks again each frame, for about half a second.
 */
export function focusSoon(ref: { current: HTMLElement | null }): void {
  const attempt = (framesLeft: number) => {
    window.requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      if ((element as HTMLElement & { disabled?: boolean }).disabled === true && framesLeft > 0) {
        attempt(framesLeft - 1);
        return;
      }
      element.focus();
    });
  };
  attempt(MAX_FRAMES);
}
