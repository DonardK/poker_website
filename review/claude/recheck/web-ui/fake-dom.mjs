/**
 * A minimal in-memory DOM, just enough for react-dom/client to mount the
 * table page and for tests to click, type and read text. No network, no
 * browser. Not a general DOM: only what the web app's table components use.
 */
const HTML_NS = 'http://www.w3.org/1999/xhtml';

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.timeStamp = performance.now();
    this.isTrusted = true;
    this._stop = false;
    this._stopImmediate = false;
    for (const [k, v] of Object.entries(init)) if (!(k in this)) this[k] = v;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._stopImmediate = true; }
  composedPath() { return this._path ?? []; }
}

class FakeEventTarget {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, fn, opts) {
    if (!fn) return;
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
    const list = this._listeners.get(type) ?? [];
    if (!list.some((l) => l.fn === fn && l.capture === capture)) list.push({ fn, capture, once: Boolean(opts?.once) });
    this._listeners.set(type, list);
  }
  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter((l) => !(l.fn === fn && l.capture === capture)));
  }
  _fire(event, phase) {
    for (const l of (this._listeners.get(event.type) ?? []).slice()) {
      if (phase === 'capture' && !l.capture) continue;
      if (phase === 'bubble' && l.capture) continue;
      if (event._stopImmediate) return;
      event.currentTarget = this;
      if (l.once) this.removeEventListener(event.type, l.fn, l.capture);
      if (typeof l.fn === 'function') l.fn.call(this, event); else l.fn.handleEvent(event);
    }
  }
  dispatchEvent(event) {
    event.target = this;
    const path = [];
    for (let n = this; n; n = n.parentNode ?? (n.nodeType === 9 ? n.defaultView : null)) path.push(n);
    event._path = path;
    const prevEvent = globalThis.window?.event;
    if (globalThis.window) globalThis.window.event = event;
    try {
      event.eventPhase = 1;
      for (let i = path.length - 1; i > 0 && !event._stop; i--) path[i]._fire(event, 'capture');
      event.eventPhase = 2;
      if (!event._stop) path[0]._fire(event, 'both');
      event.eventPhase = 3;
      if (event.bubbles) for (let i = 1; i < path.length && !event._stop; i++) path[i]._fire(event, 'bubble');
    } finally {
      if (globalThis.window) globalThis.window.event = prevEvent;
    }
    return !event.defaultPrevented;
  }
}

class FakeNode extends FakeEventTarget {
  constructor(doc) { super(); this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null; }
  get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] ?? null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { for (let n = this; n; n = n.parentNode) if (n.nodeType === 9) return true; return false; }
  hasChildNodes() { return this.childNodes.length > 0; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, ref) {
    if (child.nodeType === 11) { for (const c of child.childNodes.slice()) this.insertBefore(c, ref); return child; }
    child.parentNode?.removeChild(child);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(child); else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    const doc = this.ownerDocument ?? this;
    if (doc.activeElement && child.contains?.(doc.activeElement)) doc.activeElement = doc.body;
    return child;
  }
  replaceChild(next, old) { this.insertBefore(next, old); return this.removeChild(old); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  compareDocumentPosition(other) { return this.contains(other) ? 20 : 0; }
  get textContent() { return this.childNodes.map((c) => (c.nodeType === 8 ? '' : c.textContent)).join(''); }
  set textContent(value) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value !== '' && value != null) this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) { super(doc); this.data = String(data); }
  get nodeType() { return 3; }
  get nodeName() { return '#text'; }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class FakeComment extends FakeText {
  get nodeType() { return 8; }
  get nodeName() { return '#comment'; }
}

function makeStyle() {
  const style = {};
  Object.defineProperties(style, {
    setProperty: { value(name, value) { style[name] = String(value); } },
    removeProperty: { value(name) { delete style[name]; } },
    getPropertyValue: { value(name) { return style[name] ?? ''; } },
  });
  return style;
}

/** Selector support: comma lists of compounds made of tag, #id, .class, [attr], [attr='v'], :not(compound). */
function parseCompound(src) {
  const parts = [];
  let i = 0;
  const m = /^[a-zA-Z][\w-]*|^\*/.exec(src);
  if (m) { parts.push({ kind: 'tag', value: m[0].toLowerCase() }); i = m[0].length; }
  while (i < src.length) {
    const rest = src.slice(i);
    let mm;
    if ((mm = /^\[([\w-]+)(?:=(['"]?)(.*?)\2)?\]/.exec(rest))) { parts.push({ kind: 'attr', name: mm[1], value: mm[3] }); i += mm[0].length; }
    else if ((mm = /^#([\w-]+)/.exec(rest))) { parts.push({ kind: 'attr', name: 'id', value: mm[1] }); i += mm[0].length; }
    else if ((mm = /^\.([\w-]+)/.exec(rest))) { parts.push({ kind: 'class', value: mm[1] }); i += mm[0].length; }
    else if (rest.startsWith(':not(')) {
      let depth = 0; let j = 4;
      for (; j < rest.length; j++) { if (rest[j] === '(') depth++; else if (rest[j] === ')') { depth--; if (depth === 0) break; } }
      parts.push({ kind: 'not', inner: parseCompound(rest.slice(5, j)) }); i += j + 1;
    } else throw new Error(`fake-dom: unsupported selector part "${rest}"`);
  }
  return parts;
}
function matchesCompound(el, parts) {
  return parts.every((p) => {
    if (p.kind === 'tag') return p.value === '*' || el.localName === p.value;
    if (p.kind === 'attr') return p.value === undefined ? el.hasAttribute(p.name) : el.getAttribute(p.name) === p.value;
    if (p.kind === 'class') return (el.getAttribute('class') ?? '').split(/\s+/).includes(p.value);
    if (p.kind === 'not') return !matchesCompound(el, p.inner);
    return false;
  });
}
function splitTop(selector) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of selector) {
    if (ch === '(') depth++; if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function matches(el, selector) {
  return splitTop(selector).some((s) => {
    const compounds = s.split(/\s+/).map(parseCompound);
    if (!matchesCompound(el, compounds[compounds.length - 1])) return false;
    let node = el.parentElement;
    for (let k = compounds.length - 2; k >= 0; k--) {
      while (node && !matchesCompound(node, compounds[k])) node = node.parentElement;
      if (!node) return false;
      node = node.parentElement;
    }
    return true;
  });
}

export class FakeElement extends FakeNode {
  constructor(doc, tag, ns = HTML_NS) {
    super(doc);
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.namespaceURI = ns;
    this._attrs = new Map();
    this.style = makeStyle();
    this.inert = false;
    this.scrollTop = 0; this.scrollLeft = 0;
    if (this.localName === 'input' || this.localName === 'textarea' || this.localName === 'select') {
      this.value = ''; this.defaultValue = ''; this.checked = false; this.defaultChecked = false; this.type = 'text';
    }
  }
  get nodeType() { return 1; }
  get nodeName() { return this.tagName; }
  setAttribute(name, value) { this._attrs.set(name, String(value)); if (name === 'type' && 'type' in this) this.type = String(value); }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  removeAttribute(name) { this._attrs.delete(name); }
  hasAttribute(name) { return this._attrs.has(name); }
  setAttributeNS(_ns, name, value) { this.setAttribute(name, value); }
  removeAttributeNS(_ns, name) { this.removeAttribute(name); }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get innerHTML() { return this.textContent; }
  set innerHTML(v) { if (v === '' || v == null) this.textContent = ''; else this.textContent = String(v).replace(/<[^>]*>/g, ''); }
  matches(selector) { return matches(this, selector); }
  closest(selector) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, selector)) return n; return null; }
  querySelectorAll(selector) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (matches(c, selector)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  scrollIntoView() {}
  focus() { this.ownerDocument._focus(this); }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument._focus(this.ownerDocument.body); }
  click() {
    if (this.disabled) return;
    const proceed = this.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    // Implicit form submission for a submit button, as a browser does.
    const isSubmit = this.localName === 'button' && (this.getAttribute('type') ?? 'submit') === 'submit';
    if (proceed && isSubmit) this.closest('form')?.dispatchEvent(new FakeEvent('submit', { bubbles: true, cancelable: true }));
  }
}

export class FakeDocument extends FakeNode {
  constructor(win) {
    super(null);
    this.defaultView = win;
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.visibilityState = 'visible';
    this.hidden = false;
    // react-dom feature-detects events with `"on" + name in document`.
    for (const name of ['input', 'change', 'click', 'keydown', 'keyup', 'focusin', 'focusout', 'scroll', 'scrollend', 'pointerdown', 'selectionchange', 'beforeinput'])
      this[`on${name}`] = null;
  }
  get nodeType() { return 9; }
  get nodeName() { return '#document'; }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(ns, tag) { return new FakeElement(this, tag, ns); }
  createTextNode(data) { return new FakeText(this, data); }
  createComment(data) { return new FakeComment(this, data); }
  createDocumentFragment() { const f = new FakeElement(this, '#fragment'); Object.defineProperty(f, 'nodeType', { get: () => 11 }); return f; }
  getElementById(id) { return this.documentElement.querySelector(`#${id}`); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  querySelector(selector) { return this.documentElement.querySelector(selector); }
  _focus(el) {
    const prev = this.activeElement;
    if (prev === el) return;
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) if (n.inert) return;
    this.activeElement = el;
    prev?.dispatchEvent?.(new FakeEvent('focusout', { bubbles: true, relatedTarget: el }));
    el.dispatchEvent(new FakeEvent('focusin', { bubbles: true, relatedTarget: prev }));
  }
  getSelection() { return null; }
}

/** Install window/document globals. Returns the window. `opts.storageThrows` makes localStorage/sessionStorage throw on access. */
export function installDom(opts = {}) {
  const win = new FakeEventTarget();
  const doc = new FakeDocument(win);
  const storage = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k),
      clear: () => map.clear(), key: (i) => [...map.keys()][i] ?? null, get length() { return map.size; },
    };
  };
  const local = storage(); const session = storage();
  const blocked = () => { throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' }); };
  Object.assign(win, {
    document: doc, navigator: { userAgent: 'fake-dom', clipboard: { writeText: async () => {} } },
    location: { href: 'http://127.0.0.1:1/table/fixture-table', origin: 'http://127.0.0.1:1', pathname: '/table/fixture-table' },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, performance,
    requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 16), cancelAnimationFrame: (id) => clearTimeout(id),
    matchMedia: (q) => ({ matches: Boolean(opts.reducedMotion) && /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    getComputedStyle: (el) => el.style, scrollTo() {}, event: undefined,
    HTMLElement: FakeElement, HTMLIFrameElement: class HTMLIFrameElement {}, Node: FakeNode, Element: FakeElement, Event: FakeEvent,
    crypto: globalThis.crypto, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  });
  Object.defineProperty(win, 'localStorage', { configurable: true, get: () => (opts.storageThrows ? blocked() : local) });
  Object.defineProperty(win, 'sessionStorage', { configurable: true, get: () => (opts.storageThrows ? blocked() : session) });
  win.window = win; win.self = win; win.globalThis = win;
  globalThis.window = win;
  globalThis.document = doc;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: win.navigator });
  globalThis.HTMLElement = FakeElement; globalThis.HTMLIFrameElement = win.HTMLIFrameElement; globalThis.Node = FakeNode; globalThis.Element = FakeElement;
  globalThis.requestAnimationFrame = win.requestAnimationFrame; globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  globalThis.getComputedStyle = win.getComputedStyle;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => win.localStorage });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => win.sessionStorage });
  return win;
}

/** All elements under `root` whose own text (trimmed, collapsed) matches. */
export function byText(root, pattern) {
  return root.querySelectorAll('*').filter((el) => {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    return typeof pattern === 'string' ? text === pattern : pattern.test(text);
  });
}

/** Type into an input the way a person does: set the value, fire input (React's onChange). */
export function typeInto(input, value) {
  input.value = String(value);
  input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  input.dispatchEvent(new FakeEvent('change', { bubbles: true }));
}

export function pressKey(target, key, extra = {}) {
  target.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key, ...extra }));
}
