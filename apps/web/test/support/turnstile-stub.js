// Served in place of https://challenges.cloudflare.com/turnstile/v0/api.js in the browser specs.
// Each render and each reset issues a fresh single-use token ("stub-token-1", "stub-token-2", ...),
// and window.__turnstile records the calls, so a spec can check that a retry never resends a spent token.
(() => {
  let serial = 0;
  const widgets = new Map();
  const record = { renders: 0, resets: 0, removes: 0, tokens: [], actions: [] };
  window.__turnstile = record;
  function issue(id) {
    const widget = widgets.get(id);
    if (!widget) return;
    const token = `stub-token-${++serial}`;
    record.tokens.push(token);
    setTimeout(() => { if (widgets.has(id)) widget.params.callback?.(token); }, 20);
  }
  window.turnstile = {
    render(container, params) {
      const id = `stub-widget-${++record.renders}`;
      widgets.set(id, { container, params });
      record.actions.push(params?.action ?? null);
      issue(id);
      return id;
    },
    reset(id) {
      record.resets++;
      issue(id);
    },
    remove(id) {
      record.removes++;
      widgets.delete(id);
    },
  };
})();
