// Small building blocks for what floats above the window: menus, alerts, prompts, the picker, sheets.
import { icon } from './icons.js';

const layer = () => document.getElementById('layer');

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // only ever our own icons
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list' && k !== 'role') node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...kids.filter((x) => x !== null && x !== undefined && x !== false));
  return node;
}

/** Everything modal shares this: Esc closes, focus returns to where it was. */
function overlay(node, { scrim = false, onClose, closeOnOutside = true } = {}) {
  const before = document.activeElement;
  const root = el('div', { class: `overlay${scrim ? ' overlay--scrim' : ''}` }, node);
  layer().append(root);
  let open = true;
  const close = (value) => {
    if (!open) return;
    open = false;
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    before?.focus?.();
    onClose?.(value);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
    if (e.key === 'Tab') { // focus stays inside what is open
      const items = [...node.querySelectorAll('button, input, select, textarea, [tabindex="0"]')].filter((n) => !n.disabled && n.offsetParent);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const next = items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length];
      e.preventDefault();
      next.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  if (closeOnOutside) root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
  return { close, root };
}

/** items: { label, run, checked, danger, separator, disabled } */
export function menu(at, items) {
  const list = el('div', { class: 'ms-glass ms-glass--text ms-glass--thick ms-menu float-menu', role: 'menu' });
  const hasChecks = items.some((i) => i.checked !== undefined);
  const { close } = overlay(list);
  for (const it of items) {
    if (it.separator) { list.append(el('div', { class: 'ms-menu__separator', role: 'separator' })); continue; }
    list.append(el('button', {
      class: `ms-menu__item menu-btn${it.danger ? ' menu-btn--danger' : ''}`, role: hasChecks ? 'menuitemradio' : 'menuitem',
      disabled: !!it.disabled, 'aria-checked': hasChecks ? String(!!it.checked) : undefined,
      html: hasChecks ? icon('check') : '',
      onclick: () => { close(); it.run?.(); },
    }, it.label));
  }
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = [...list.querySelectorAll('button:not(:disabled)')];
    const i = btns.indexOf(document.activeElement);
    btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
  });
  place(list, at);
  list.querySelector('button:not(:disabled)')?.focus();
}

function place(node, at) {
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, bottom: at.y, top: at.y };
  node.style.position = 'fixed';
  const { width, height } = node.getBoundingClientRect();
  const x = Math.min(r.left, innerWidth - width - 12);
  const below = r.bottom + 6 + height < innerHeight - 12;
  node.style.left = `${Math.max(12, x)}px`;
  node.style.top = `${Math.max(12, below ? r.bottom + 6 : r.top - height - 6)}px`;
  node.style.transformOrigin = `${r.left - x}px ${below ? '0' : '100%'}`;
}

export function alertDialog({ title, text, actions }) {
  return new Promise((resolve) => {
    const box = el('div', { class: 'ms-glass ms-glass--text ms-glass--thick ms-alert', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title });
    const { close } = overlay(box, { scrim: true, onClose: (v) => resolve(v) });
    box.append(el('h2', { class: 'ms-alert__title' }, title));
    if (text) box.append(el('p', { class: 'ms-alert__text' }, text));
    const row = el('div', { class: 'alert-actions' });
    for (const a of actions) {
      row.append(el('button', { class: `ms-button ${a.primary ? 'ms-button--prominent' : ''} ${a.danger ? 'ms-button--destructive' : ''}`, onclick: () => close(a.value) }, a.label));
    }
    box.append(row);
    (row.querySelector('.ms-button--prominent') ?? row.querySelector('button')).focus();
  });
}

export function promptDialog({ title, value = '', placeholder = '', action = 'Fertig' }) {
  return new Promise((resolve) => {
    const box = el('form', { class: 'ms-glass ms-glass--text ms-glass--thick ms-alert', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const { close } = overlay(box, { scrim: true, onClose: (v) => resolve(v ?? null) });
    const input = el('input', { class: 'ms-field wide', value, placeholder, 'aria-label': title });
    box.append(
      el('h2', { class: 'ms-alert__title' }, title), input,
      el('div', { class: 'alert-actions' },
        el('button', { class: 'ms-button', type: 'button', onclick: () => close(null) }, 'Abbrechen'),
        el('button', { class: 'ms-button ms-button--prominent', type: 'submit' }, action)),
    );
    box.addEventListener('submit', (e) => { e.preventDefault(); close(input.value.trim() || null); });
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
}

/** A list to type into: the command palette and the folder picker. items: { label, hint, run } */
export function pick({ title, items }) {
  const box = el('div', { class: 'ms-glass ms-glass--text ms-glass--thick picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const { close } = overlay(box, { scrim: true });
  const input = el('input', { class: 'ms-field wide', placeholder: title, 'aria-label': title, role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'picker-list' });
  const list = el('div', { class: 'picker-list ms-scroll', id: 'picker-list', role: 'listbox' });
  box.append(input, list);
  let shown = [];
  let active = 0;
  const paint = () => {
    list.replaceChildren(...shown.map((it, i) => el('button', {
      class: `picker-row${i === active ? ' is-active' : ''}`, role: 'option', 'aria-selected': String(i === active), tabIndex: -1,
      onclick: () => { close(); it.run(); },
    }, el('span', {}, it.label), it.hint ? el('span', { class: 'picker-hint ms-num' }, it.hint) : null)));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const filter = () => {
    const q = input.value.toLowerCase();
    shown = items.filter((i) => i.label.toLowerCase().includes(q));
    active = 0;
    paint();
  };
  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); paint(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    if (e.key === 'Enter') { e.preventDefault(); const it = shown[active]; if (it) { close(); it.run(); } }
  });
  filter();
  input.focus();
}

/** A card over the dimmed window, for settings, history, trash and search. */
export function sheet(title, { wide = false } = {}) {
  const body = el('div', { class: 'sheet-body ms-scroll' });
  const box = el('div', { class: `sheet${wide ? ' sheet--wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('header', { class: 'sheet-head' },
      el('h2', { class: 'ms-headline' }, title),
      el('button', { class: 'round-btn', 'aria-label': 'Schließen', title: 'Schließen', html: icon('close'), onclick: () => close() })),
    body);
  const { close } = overlay(box, { scrim: true });
  box.querySelector('.round-btn').focus();
  return { body, close };
}

export const section = (title, ...rows) => [el('div', { class: 'ms-section sheet-section' }, title), el('section', { class: 'ms-card' }, ...rows)];

export function row({ tile, color, label, end, hint }) {
  return el('div', { class: 'ms-row' },
    tile ? el('span', { class: 'ms-icon-tile', style: `--_c: var(--ms-color-category-${color ?? 'general'})`, html: icon(tile) }) : null,
    el('span', { class: 'ms-row__label' }, label, hint ? el('span', { class: 'row-hint ms-caption ms-secondary' }, hint) : null),
    el('span', { class: 'ms-row__end' }, end));
}

export const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
