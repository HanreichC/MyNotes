// The Notion half: TipTap, with Markdown on disk. It regenerates the Markdown when saving, so isFaithful() checks
// on opening that nothing would be lost, and the store keeps the original in the history (docs/PLAN.md § 4).
import { Editor, Extension, InputRule } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Image } from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { StarterKit } from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { Marked } from 'marked';
import { t } from '../shared/i18n.js';
import { isJson } from '../shared/json.js';
import { icon } from './icons.js';
import { count, el, menu, promptDialog } from './ui.js';

const lowlight = createLowlight(common);

const assetUrl = (src) => (!src || /^(data:|https?:|mynotes:)/.test(src) ? src : `mynotes://asset/${src.split('/').map(encodeURIComponent).join('/')}`);

const NoteImage = Image.extend({
  addAttributes() {
    const parent = this.parent();
    return { ...parent, src: { ...parent.src, renderHTML: (attrs) => ({ src: assetUrl(attrs.src) }) } };
  },
});

/**
 * TipTap writes the first empty paragraph of a run as nothing, and Markdown swallows it on the next load: two blank
 * lines come back as one. So every blank line between blocks is written out, and only the end of the file is trimmed.
 */
const BlankLineParagraph = Paragraph.extend({
  renderMarkdown: (node, h, ctx) => {
    const content = Array.isArray(node?.content) ? node.content : [];
    if (content.length) return h.renderChildren(content);
    return ctx?.parentType === 'doc' ? '&nbsp;' : ''; // inside a list or a table cell it would show up as text
  },
});
const trimEnd = (md) => md.replace(/(?:\s*&nbsp;)+\s*$/, '');

/** "- [ ] " is what everyone types from Markdown habit; TipTap only knows "[ ] " outside of a list. */
const TaskShortcut = Extension.create({
  name: 'taskShortcut',
  priority: 1000,
  addInputRules() {
    return [new InputRule({
      find: /^\[([ xX])?\]\s$/,
      handler: ({ state, range, match, chain }) => {
        if (state.selection.$from.node(-1)?.type.name !== 'listItem') return null;
        chain().deleteRange(range).toggleTaskList().updateAttributes('taskItem', { checked: /x/i.test(match[1] ?? '') }).run();
        return undefined;
      },
    })];
  },
});

/**
 * A tab at the start of a line would come back as a code block when the Markdown is read again, and spaces would vanish.
 * Two em spaces survive that and read as an indent, so that is what Tab means in running text.
 */
const INDENT = '  ';

/** Below the lists, tables and code blocks, which use Tab themselves: this is what is left when they have no use for the key. */
const TabKey = Extension.create({
  name: 'tabKey',
  priority: 10,
  addKeyboardShortcuts() {
    const blocks = (fn) => {
      const { state, view } = this.editor;
      const tr = state.tr;
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (!node.isTextblock) return true;
        if (node.type.name !== 'codeBlock') fn(tr, node, tr.mapping.map(pos + 1));
        return false;
      });
      if (tr.docChanged) view.dispatch(tr);
      return true; // always taken: Esc, then Tab, is the way out of the editor (createMdEditor)
    };
    return {
      Tab: () => {
        if (this.editor.isActive('listItem') || this.editor.isActive('taskItem')) return true; // the first item has nothing to go under
        if (!this.editor.state.selection.empty) return blocks((tr, _node, at) => tr.insertText(INDENT, at));
        this.editor.view.dispatch(this.editor.state.tr.insertText(INDENT));
        return true;
      },
      'Shift-Tab': () => blocks((tr, node, at) => { if (node.textContent.startsWith(INDENT)) tr.delete(at, at + INDENT.length); }),
    };
  },
});

// ---------------------------------------------------------------- find and replace

const findKey = new PluginKey('find');

/** Matches per text block, so a match never spans two paragraphs. */
function findMatches(doc, query, { regex, caseSensitive }) {
  if (!query) return [];
  let re;
  try { re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu'); }
  catch { return []; }
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // leaf nodes count as one position, so text offsets stay document offsets
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    for (const m of text.matchAll(re)) {
      if (m[0]) out.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
    }
    return false;
  });
  return out;
}

const FindPlugin = Extension.create({
  name: 'find',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: findKey,
      state: {
        init: () => ({ query: '', opts: {}, matches: [], index: 0 }),
        apply(tr, prev) {
          const meta = tr.getMeta(findKey);
          const next = meta ? { ...prev, ...meta } : prev;
          if (!meta && !tr.docChanged) return next;
          return { ...next, matches: findMatches(tr.doc, next.query, next.opts) };
        },
      },
      props: {
        decorations(state) {
          const { matches, index } = findKey.getState(state);
          if (!matches.length) return null;
          return DecorationSet.create(state.doc, matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? 'find-hit find-hit--on' : 'find-hit' })));
        },
      },
    })];
  },
});

function createFindBar(host, editor) {
  const view = () => editor.view;
  const state = () => findKey.getState(editor.state);
  const query = el('input', { class: 'ms-field', placeholder: t('Suchen'), 'aria-label': t('Suchen') });
  const replacement = el('input', { class: 'ms-field', placeholder: t('Ersetzen'), 'aria-label': t('Ersetzen') });
  const regex = el('input', { type: 'checkbox', class: 'ms-checkbox' });
  const cased = el('input', { type: 'checkbox', class: 'ms-checkbox' });
  const count = el('span', { class: 'ms-caption ms-secondary ms-num find-count', role: 'status' });
  const paint = () => {
    const { matches, index } = state();
    count.textContent = matches.length ? t('{n} von {total}', { n: index + 1, total: matches.length }) : query.value ? t('Kein Treffer') : '';
  };
  const run = () => {
    view().dispatch(view().state.tr.setMeta(findKey, { query: query.value, opts: { regex: regex.checked, caseSensitive: cased.checked }, index: 0 }));
    view().dispatch(view().state.tr.setMeta(findKey, { matches: findMatches(editor.state.doc, query.value, { regex: regex.checked, caseSensitive: cased.checked }) }));
    jump(0);
  };
  const jump = (delta) => {
    const { matches, index } = state();
    if (!matches.length) { paint(); return; }
    const i = (index + delta + matches.length) % matches.length;
    const m = matches[i];
    view().dispatch(view().state.tr.setMeta(findKey, { index: i }).setSelection(TextSelection.create(view().state.doc, m.from, m.to)).scrollIntoView());
    paint();
  };
  const replaceOne = () => {
    const { matches, index } = state();
    const m = matches[index];
    if (!m) return;
    view().dispatch(view().state.tr.insertText(replacement.value, m.from, m.to));
    jump(0);
  };
  const replaceAll = () => {
    const { matches } = state();
    if (!matches.length) return;
    const tr = view().state.tr;
    for (const m of [...matches].reverse()) tr.insertText(replacement.value, m.from, m.to);
    view().dispatch(tr);
    paint();
  };
  const bar = el('div', { class: 'find-bar', hidden: true },
    query, replacement,
    el('button', { class: 'ms-button', onclick: () => jump(-1) }, t('Zurück')),
    el('button', { class: 'ms-button', onclick: () => jump(1) }, t('Weiter')),
    el('button', { class: 'ms-button', onclick: replaceOne }, t('Ersetzen')),
    el('button', { class: 'ms-button', onclick: replaceAll }, t('Alle ersetzen')),
    el('label', { class: 'ms-check-label ms-callout' }, regex, 'Regex'),
    el('label', { class: 'ms-check-label ms-callout' }, cased, t('Groß/klein')),
    count,
    el('button', { class: 'round-btn round-btn--s', 'aria-label': t('Suche schließen'), title: t('Suche schließen'), html: icon('close'), onclick: () => hide() }));
  const hide = () => {
    bar.hidden = true;
    view().dispatch(view().state.tr.setMeta(findKey, { query: '', matches: [], index: 0 }));
    editor.commands.focus();
  };
  for (const input of [query, regex, cased]) input.addEventListener(input === query ? 'input' : 'change', run);
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
  });
  host.prepend(bar);
  return {
    open(initial) {
      bar.hidden = false;
      if (initial !== undefined) { query.value = initial; run(); }
      else {
        const { from, to } = editor.state.selection;
        if (from !== to) { query.value = editor.state.doc.textBetween(from, to); run(); }
      }
      query.focus();
      query.select();
    },
  };
}

// ---------------------------------------------------------------- slash menu

const SLASH = [
  { label: t('Überschrift 1'), keys: 'h1 titel', run: (c) => c.toggleHeading({ level: 1 }) },
  { label: t('Überschrift 2'), keys: 'h2', run: (c) => c.toggleHeading({ level: 2 }) },
  { label: t('Überschrift 3'), keys: 'h3', run: (c) => c.toggleHeading({ level: 3 }) },
  { label: t('Liste'), keys: 'aufzählung bullet', run: (c) => c.toggleBulletList() },
  { label: t('Nummerierte Liste'), keys: 'zahlen ordered', run: (c) => c.toggleOrderedList() },
  { label: t('Checkliste'), keys: 'aufgabe todo task', run: (c) => c.toggleTaskList() },
  { label: t('Zitat'), keys: 'quote', run: (c) => c.toggleBlockquote() },
  { label: t('Code-Block'), keys: 'code', run: (c) => c.toggleCodeBlock() },
  { label: t('JSON-Block'), keys: 'json', run: (c) => c.toggleCodeBlock({ language: 'json' }) },
  { label: t('Tabelle'), keys: 'table', run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { label: t('Trennlinie'), keys: 'hr linie', run: (c) => c.setHorizontalRule() },
];

function createSlashMenu(editor) {
  const box = el('div', { class: 'ms-glass ms-glass--text ms-glass--thick ms-menu slash-menu', role: 'listbox', 'aria-label': t('Block einfügen'), hidden: true });
  document.getElementById('layer').append(box);
  let items = [];
  let active = 0;
  let range = null;
  const hide = () => { box.hidden = true; range = null; };
  const apply = (it) => {
    const chain = editor.chain().focus().deleteRange(range);
    hide();
    it.run(chain).run();
  };
  const paint = () => {
    box.replaceChildren(...items.map((it, i) => el('button', {
      class: `ms-menu__item menu-btn${i === active ? ' is-hover' : ''}`, role: 'option', 'aria-selected': String(i === active), tabIndex: -1,
      onmousedown: (e) => { e.preventDefault(); apply(it); },
    }, it.label)));
  };
  const check = () => {
    const { $from, empty } = editor.state.selection;
    if (!empty || !$from.parent.isTextblock || $from.parent.type.name === 'codeBlock') return hide();
    const m = /^\/([\p{L}\p{N}-]*)$/u.exec($from.parent.textBetween(0, $from.parentOffset, undefined, '￼'));
    if (!m) return hide();
    const q = m[1].toLowerCase();
    items = SLASH.filter((s) => `${s.label} ${s.keys}`.toLowerCase().includes(q));
    if (!items.length) return hide();
    range = { from: $from.pos - m[0].length, to: $from.pos };
    active = Math.min(active, items.length - 1);
    paint();
    box.hidden = false;
    const at = editor.view.coordsAtPos($from.pos);
    const { height, width } = box.getBoundingClientRect();
    box.style.left = `${Math.min(at.left, innerWidth - width - 12)}px`;
    box.style.top = `${at.bottom + 6 + height > innerHeight - 12 ? at.top - height - 6 : at.bottom + 6}px`;
  };
  return {
    check,
    destroy: () => box.remove(),
    /** Returns true if the menu took the key. */
    key(e) {
      if (box.hidden) return false;
      if (e.key === 'ArrowDown') active = (active + 1) % items.length;
      else if (e.key === 'ArrowUp') active = (active - 1 + items.length) % items.length;
      else if (e.key === 'Enter' || e.key === 'Tab') { apply(items[active]); return true; }
      else if (e.key === 'Escape') { hide(); return true; }
      else return false;
      paint();
      return true;
    },
  };
}

// ---------------------------------------------------------------- floating toolbar

function createToolbar(editor, onLink) {
  const button = (name, label, run, isOn) => {
    const b = el('button', { class: 'tool-btn', 'aria-label': label, title: label, html: icon(name), onmousedown: (e) => e.preventDefault(), onclick: run });
    b.isOn = isOn;
    return b;
  };
  const textBtn = (text, label, run) => el('button', { class: 'tool-btn tool-btn--text', title: label, onmousedown: (e) => e.preventDefault(), onclick: run }, text);
  const c = () => editor.chain().focus();
  const marks = [
    button('bold', t('Fett'), () => c().toggleBold().run(), () => editor.isActive('bold')),
    button('italic', t('Kursiv'), () => c().toggleItalic().run(), () => editor.isActive('italic')),
    button('strike', t('Durchgestrichen'), () => c().toggleStrike().run(), () => editor.isActive('strike')),
    button('code', t('Inline-Code'), () => c().toggleCode().run(), () => editor.isActive('code')),
    button('link', t('Link'), onLink, () => editor.isActive('link')),
  ];
  const table = [
    textBtn(t('Zeile +'), t('Zeile einfügen'), () => c().addRowAfter().run()),
    textBtn(t('Zeile −'), t('Zeile löschen'), () => c().deleteRow().run()),
    textBtn(t('Spalte +'), t('Spalte einfügen'), () => c().addColumnAfter().run()),
    textBtn(t('Spalte −'), t('Spalte löschen'), () => c().deleteColumn().run()),
    textBtn(t('Tabelle löschen'), t('Tabelle löschen'), () => c().deleteTable().run()),
  ];
  const box = el('div', { class: 'ms-glass ms-glass--capsule ms-glass--thin toolbar', role: 'toolbar', 'aria-label': t('Formatierung'), hidden: true });
  document.getElementById('layer').append(box);
  const update = () => {
    const { from, to, empty } = editor.state.selection;
    const inTable = editor.isActive('table');
    const showMarks = !empty && !editor.isActive('codeBlock');
    if (!editor.isFocused || (!showMarks && !inTable)) { box.hidden = true; return; }
    box.replaceChildren(...(showMarks ? marks : table));
    for (const b of marks) b.classList.toggle('is-on', !!b.isOn());
    box.hidden = false;
    const a = editor.view.coordsAtPos(from);
    const z = editor.view.coordsAtPos(to);
    const { width, height } = box.getBoundingClientRect();
    const x = Math.max(12, Math.min((a.left + z.right) / 2 - width / 2, innerWidth - width - 12));
    box.style.left = `${x}px`;
    box.style.top = `${a.top - height - 8 < 60 ? z.bottom + 8 : a.top - height - 8}px`;
  };
  return { update, hide: () => { box.hidden = true; }, destroy: () => box.remove() };
}

// ---------------------------------------------------------------- the editor

// Its own instance: TipTap registers token types on the global one that a plain parse cannot render.
const marked = new Marked({ gfm: true, async: false });
// A list mixing checkboxes and plain points comes back with a blank line in it, which Markdown calls a "loose" list:
// same text in the same order, only the spacing differs, so the tight/loose difference does not count.
const canon = (md) => marked.parse(md).replace(/\s+/g, ' ').replace(/> </g, '><').replaceAll('<li><p>', '<li>').replaceAll('</p></li>', '</li>').trim();

/** Would the regenerated Markdown still mean the same? If we cannot tell, the answer is no. */
export function isFaithful(original, regenerated) {
  try { return canon(original) === canon(regenerated); } catch { return false; }
}

export function createMdEditor({ parent, text, onChange, onCursor, onJsonIntoEmpty, onImageError, prettyPasted }) {
  let slash;
  let pasteAsCode = false;
  const host = el('div', { class: 'prose-host ms-scroll' });
  parent.append(host);
  // Tab belongs to the text now, so the keyboard needs another way out (A-2): Esc, then Tab within 2 s, as in the code editor.
  let tabLeavesUntil = 0;
  host.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') tabLeavesUntil = Date.now() + 2000;
    else if (e.key === 'Tab' && Date.now() <= tabLeavesUntil) e.stopPropagation();
    else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) tabLeavesUntil = 0;
  }, true);

  const editor = new Editor({
    element: host,
    content: text,
    contentType: 'markdown',
    extensions: [
      StarterKit.configure({ codeBlock: false, paragraph: false, link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow' } } }),
      BlankLineParagraph,
      Markdown,
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: null, enableTabIndentation: true, tabSize: 2 }),
      NoteImage.configure({ inline: true }),
      FindPlugin,
      TaskShortcut,
      TabKey,
    ],
    editorProps: {
      attributes: { class: 'prose', 'aria-label': t('Notiz'), role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (_view, e) => {
        if (slash?.key(e)) { e.preventDefault(); return true; }
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') { pasteAsCode = true; }
        return false;
      },
      handleClick: (_view, _pos, e) => {
        const a = e.target.closest?.('a[href]');
        if (a && (e.ctrlKey || e.metaKey)) { window.api.openLink(a.href); return true; }
        return false;
      },
      handlePaste: (_view, e) => {
        const image = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
        if (image) { insertImage(image); return true; }
        const plain = e.clipboardData?.getData('text/plain') ?? '';
        const asCode = pasteAsCode;
        pasteAsCode = false;
        if (plain && (asCode || isJson(plain))) {
          if (!asCode && editor.isEmpty) { onJsonIntoEmpty(plain); return true; }
          editor.chain().focus().insertContent({
            // Strg+Umschalt+V means "exactly as it is", so only a plain paste gets formatted.
            type: 'codeBlock', attrs: { language: isJson(plain) ? 'json' : null }, content: [{ type: 'text', text: asCode ? plain : prettyPasted(plain) }],
          }).run();
          return true;
        }
        return false;
      },
      handleDrop: (_view, e) => {
        const image = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
        if (!image) return false;
        insertImage(image);
        return true;
      },
    },
    onUpdate: () => { paintEmpty(); slash.check(); toolbar.update(); onChange(); },
    onSelectionUpdate: () => { slash.check(); toolbar.update(); onCursor(); },
    onFocus: () => toolbar.update(),
    onBlur: () => toolbar.hide(),
  });

  function paintEmpty() { host.classList.toggle('is-empty', editor.isEmpty); }
  paintEmpty();

  async function insertImage(file) {
    try {
      const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
      const src = await window.api.saveImage(new Uint8Array(await file.arrayBuffer()), ext);
      editor.chain().focus().setImage({ src, alt: file.name || '' }).run();
    } catch (e) { onImageError(e.message); }
  }

  async function editLink() {
    const current = editor.getAttributes('link').href ?? '';
    const href = await promptDialog({ title: t('Link'), value: current, placeholder: 'https://…', action: t('Übernehmen') });
    if (href === null) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }

  slash = createSlashMenu(editor);
  const toolbar = createToolbar(editor, editLink);
  const findBar = createFindBar(parent, editor);

  return {
    kind: 'rich',
    getText: () => trimEnd(editor.getMarkdown()),
    setText(next) { editor.commands.setContent(next, { contentType: 'markdown', emitUpdate: false }); paintEmpty(); },
    focus: () => editor.view.focus(), // at once: commands.focus() waits a frame, and keys typed right after Ctrl+T would miss
    destroy() { slash.destroy(); toolbar.destroy(); editor.destroy(); host.remove(); },
    setWrap() {},
    position() {
      // One line per block and hard break. textContent would glue paragraphs together and count their edges as one word.
      const { doc } = editor.state;
      const text = doc.textBetween(0, doc.content.size, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''));
      // trimEnd: the editor keeps an empty paragraph after a list or table for the cursor, and nobody counts that as a line.
      return `${count(text.trim().split(/\s+/).filter(Boolean).length, t('Wort'), t('Wörter'))} · ${count(text.trimEnd().split('\n').length, t('Zeile'), t('Zeilen'))}`;
    },
    /** JSON tools work on the selection or the code block under the cursor. */
    transform(fn) {
      const { state } = editor;
      const { from, to, empty, $from } = state.selection;
      if ($from.parent.type.name === 'codeBlock' && empty) {
        const start = $from.start();
        const out = fn($from.parent.textContent);
        editor.view.dispatch(state.tr.replaceWith(start, start + $from.parent.content.size, state.schema.text(out)));
        return;
      }
      if (empty) throw new Error(t('Markiere den JSON-Text oder setze den Cursor in einen Code-Block.'));
      editor.view.dispatch(state.tr.insertText(fn(state.doc.textBetween(from, to, '\n')), from, to));
    },
    find: (initial) => findBar.open(initial),
    getCursor: () => ({ pos: editor.state.selection.from, scroll: host.scrollTop }),
    setCursor({ pos = 0, scroll = 0 } = {}) {
      const max = editor.state.doc.content.size;
      try { editor.commands.setTextSelection(Math.min(Math.max(pos, 0), max)); } catch { /* the document changed */ }
      requestAnimationFrame(() => { host.scrollTop = scroll; });
    },
    editLink,
    menu,
  };
}
