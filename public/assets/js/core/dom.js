/**
 * DOM helpers.
 *
 * Small on purpose. `el` builds an element from a tag, a props object and
 * children; everything in the interface is built from it. Text always goes in
 * through textContent, so a client's company name cannot become markup — the
 * few places that need HTML say `html:` and are individually reviewable.
 */

/**
 * el('div.mm-card', { id: 'x' }, child, child)
 *
 * The tag string carries an optional `.class.list` and `#id`, which keeps
 * call sites readable when the props object would otherwise hold nothing but
 * a className.
 */
export function el(spec, props = null, ...children) {
  const { tag, classes, id } = parseSpec(spec);
  const node = document.createElement(tag);

  if (classes.length) node.className = classes.join(' ');
  if (id) node.id = id;

  if (props && typeof props === 'object' && !isChild(props)) {
    applyProps(node, props);
  } else if (props !== null && props !== undefined) {
    children.unshift(props);
  }

  append(node, children);
  return node;
}

function parseSpec(spec) {
  if (typeof spec !== 'string') return { tag: 'div', classes: [], id: null };
  const [head, ...classParts] = spec.split('.');
  const [tagPart, idPart] = head.split('#');
  const last = classParts.length ? classParts[classParts.length - 1] : null;

  let id = idPart ?? null;
  const classes = classParts.slice();
  if (last && last.includes('#')) {
    const [cls, tail] = last.split('#');
    classes[classes.length - 1] = cls;
    id = tail;
  }
  return { tag: tagPart || 'div', classes: classes.filter(Boolean), id };
}

function isChild(value) {
  return value instanceof Node || Array.isArray(value) || typeof value === 'string'
    || typeof value === 'number';
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class' || key === 'className') {
      node.className = [node.className, value].filter(Boolean).join(' ');
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      // Deliberate, and only ever used with strings this application built —
      // never with anything that came back from the API.
      node.innerHTML = value;
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) {
        if (v !== null && v !== undefined) node.dataset[k] = String(v);
      }
    } else if (key === 'style' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) node.style.setProperty(k, v);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'disabled' || key === 'checked' || key === 'selected'
      || key === 'required' || key === 'readOnly' || key === 'multiple' || key === 'open') {
      node[key] = !!value;
    } else if (key === 'value') {
      node.value = value;
    } else if (key === 'ref' && typeof value === 'function') {
      value(node);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace a node's children in one step. */
export function render(host, ...children) {
  host.replaceChildren();
  append(host, children);
  return host;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** A document fragment, for returning several siblings from one function. */
export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** Remove every child without discarding the host. */
export function clear(node) {
  node.replaceChildren();
  return node;
}

/**
 * Delegate an event from a container.
 *
 * Rows are re-rendered constantly, so binding to each one leaks listeners and
 * loses them on every refresh. One listener on the container survives both.
 */
export function on(host, event, selector, handler) {
  host.addEventListener(event, (e) => {
    const match = e.target.closest(selector);
    if (match && host.contains(match)) handler(e, match);
  });
  return host;
}

/** Focus the first focusable descendant — used when a modal or drawer opens. */
export function focusFirst(root) {
  const target = root.querySelector(
    'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])');
  if (target) target.focus();
}

/**
 * Trap the tab key inside a container.
 *
 * Without this a keyboard user tabs straight out of an open dialog and into
 * the page behind it, which is disorienting and, for a confirmation dialog,
 * genuinely dangerous.
 */
export function trapFocus(root) {
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(n => n.offsetParent !== null);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  root.addEventListener('keydown', handler);
  return () => root.removeEventListener('keydown', handler);
}

/** Debounce — for search boxes, where a keystroke should not be a request. */
export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
