// The Notepad++ half: CodeMirror keeps text exactly as it is. For code, JSON, plain text and Markdown source.
import { copyLineDown, deleteLine, indentLess, indentMore, isolateHistory, moveLineDown, moveLineUp } from '@codemirror/commands';
import { HighlightStyle, indentUnit, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { goToNextChunk, goToPreviousChunk, MergeView } from '@codemirror/merge';
import { gotoLine, openSearchPanel, search } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { language, t } from '../shared/i18n.js';
import { changedSpan } from '../shared/text.js';
import { count } from './ui.js';

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: 'var(--ms-color-system-purple)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--ms-color-system-green)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--ms-color-system-orange)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--ms-color-label-secondary)', fontStyle: 'italic' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--ms-color-accent-text)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.typeName, tags.className, tags.tagName], color: 'var(--ms-color-system-teal)' },
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--ms-color-accent-text)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--ms-color-system-red)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--ms-color-label-primary)', backgroundColor: 'transparent', fontSize: 'var(--editor-size)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--ms-font-family-mono)', lineHeight: '1.55', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--ms-color-accent-text)', padding: 'var(--ms-space-m) 0' },
  '.cm-cursor': { borderLeftColor: 'var(--ms-color-accent-text)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--ms-color-label-tertiary)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ms-color-label-primary)' },
  '.cm-activeLine': { backgroundColor: 'var(--ms-color-fill-quaternary, var(--ms-color-fill-tertiary))' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'color-mix(in srgb, var(--ms-color-accent) 32%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--ms-color-system-yellow) 25%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--ms-color-system-yellow) 40%, transparent)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--ms-color-system-orange) 55%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--ms-color-fill-secondary)', outline: 'none' },
  '.cm-panels': { backgroundColor: 'transparent', color: 'var(--ms-color-label-primary)', border: 'none' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--ms-color-separator-default)' },
  '.cm-panel.cm-search': { padding: 'var(--ms-space-s) var(--ms-space-m)', fontFamily: 'var(--ms-font-family)', fontSize: 'var(--ms-typography-desktop-callout-size)' },
  '.cm-panel.cm-search label': { fontSize: 'var(--ms-typography-desktop-callout-size)', display: 'inline-flex', alignItems: 'center', gap: '4px' },
  '.cm-textfield': { height: 'var(--ms-size-control-desktop)', padding: '0 10px', border: '0', borderRadius: 'var(--ms-radius-control)', backgroundColor: 'var(--ms-color-fill-tertiary)', color: 'inherit', fontFamily: 'var(--ms-font-family)', fontSize: 'var(--ms-typography-desktop-body-size)' },
  '.cm-button': { height: 'var(--ms-size-control-desktop)', padding: '0 12px', border: '0', borderRadius: 'var(--ms-radius-capsule)', backgroundImage: 'none', backgroundColor: 'var(--ms-color-fill-tertiary)', color: 'var(--ms-color-label-primary)', fontFamily: 'var(--ms-font-family)', fontWeight: '600', fontSize: 'var(--ms-typography-desktop-callout-size)' },
  '.cm-panel.cm-search [name=close]': { width: 'var(--ms-size-hit-min-desktop)', height: 'var(--ms-size-hit-min-desktop)', top: 'var(--ms-space-s)', right: 'var(--ms-space-s)', borderRadius: 'var(--ms-radius-capsule)', color: 'var(--ms-color-label-secondary)', fontSize: 'var(--ms-typography-desktop-headline-size)' },
  '.cm-panel.cm-search [name=close]:hover': { backgroundColor: 'var(--ms-color-fill-tertiary)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--ms-color-fill-tertiary)', border: 'none', color: 'var(--ms-color-label-secondary)' },
  '.cm-tooltip': { backgroundColor: 'var(--ms-color-glass-opaque-top)', border: '1px solid var(--ms-color-glass-popup-border)', borderRadius: 'var(--ms-radius-control)' },
});

// CodeMirror speaks English by itself.
const german = language() === 'en' ? [] : EditorState.phrases.of({
  Find: 'Suchen', Replace: 'Ersetzen', next: 'Weiter', previous: 'Zurück', all: 'Alle', replace: 'Ersetzen', 'replace all': 'Alle ersetzen',
  'match case': 'Groß/klein', regexp: 'Regex', 'by word': 'Ganze Wörter', close: 'Schließen', 'current match': 'aktueller Treffer',
  'on line': 'in Zeile', 'replaced match on line $': 'Treffer in Zeile $ ersetzt', 'replaced $ matches': '$ Treffer ersetzt',
  'Go to line': 'Gehe zu Zeile', go: 'Los', 'Folded lines': 'Eingeklappte Zeilen', 'Unfolded lines': 'Ausgeklappte Zeilen',
});

/** Selected lines, or every line if nothing is selected. */
function changeLines(view, fn) {
  const { state } = view;
  const sel = state.selection.main;
  const from = sel.empty ? 0 : state.doc.lineAt(sel.from).from;
  const to = sel.empty ? state.doc.length : state.doc.lineAt(sel.to).to;
  const next = fn(state.sliceDoc(from, to).split('\n')).join('\n');
  view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input' });
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' }); // the same order in both languages

export const lineCommands = {
  sortAsc: (lines) => [...lines].sort(collator.compare),
  sortDesc: (lines) => [...lines].sort((a, b) => collator.compare(b, a)),
  unique: (lines) => [...new Set(lines)],
  trimEnd: (lines) => lines.map((l) => l.trimEnd()),
  dropEmpty: (lines) => lines.filter((l) => l.trim()),
};

/**
 * A file keeps its own indentation: Tab and Enter follow the first indented line, and a tab if there is none yet.
 * Otherwise a Makefile gets spaces, and a tab followed by Enter gets spaces on the next line.
 * ponytail: only looks at the first 1000 lines, so a huge file without indentation does not cost a scan per keystroke.
 */
const fileIndent = indentUnit.compute(['doc'], ({ doc }) => {
  for (let n = 1; n <= Math.min(doc.lines, 1000); n++) {
    const found = /^(\t| {2,})/.exec(doc.line(n).text);
    if (found) return found[1];
  }
  return '\t';
});

/** As in Notepad++: inserts at the cursor, indents whole lines when something is selected. Esc, then Tab, leaves the editor. */
const tabKey = {
  key: 'Tab',
  shift: indentLess,
  run(view) {
    const { state } = view;
    if (state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
    view.dispatch(state.update(state.replaceSelection(state.facet(indentUnit)), { scrollIntoView: true, userEvent: 'input' }));
    return true;
  },
};

function codeSetup({ wrap, onChange, onCursor, onPaste }) {
  const wrapping = new Compartment();
  const language = new Compartment();
  const spelling = new Compartment();
  return {
    wrapping,
    language,
    spelling,
    extensions: [
      fileIndent,
      Prec.high(keymap.of([
        tabKey,
        { key: 'Mod-d', run: copyLineDown, preventDefault: true }, // as in Notepad++
        { key: 'Mod-l', run: deleteLine, preventDefault: true },
        { key: 'Mod-Shift-ArrowUp', run: moveLineUp },
        { key: 'Mod-Shift-ArrowDown', run: moveLineDown },
        { key: 'Mod-h', run: openSearchPanel, preventDefault: true },
        { key: 'Mod-g', run: gotoLine, preventDefault: true },
      ])),
      basicSetup,
      search({ top: true }), // W-5: nothing important at the lower window edge
      syntaxHighlighting(highlight),
      EditorState.allowMultipleSelections.of(true),
      german,
      theme,
      language.of([]),
      spelling.of([]),
      wrapping.of(wrap ? EditorView.lineWrapping : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange();
        if (u.docChanged || u.selectionSet) onCursor();
        if (u.transactions.some((tr) => tr.isUserEvent('input.paste'))) onPaste();
      }),
      EditorView.contentAttributes.of({ 'aria-label': t('Code-Editor') }),
    ],
  };
}

export function createCodeEditor({ parent, text, name, ...rest }) {
  const setup = codeSetup(rest);
  const view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: setup.extensions }) });
  return editorApi(view, setup, name, () => view.destroy());
}

/**
 * Two editors that show their differences, as in WinMerge: same lines side by side, one scrollbar, both stay editable.
 * Either side's destroy() goes to onDestroy, because one side cannot go on without the other.
 */
export function createCompareEditors({ parent, wrap, sides: [left, right], onDiffChange, onDestroy }) {
  const shared = [
    Prec.highest(keymap.of([{ key: 'Alt-ArrowDown', run: goToNextChunk }, { key: 'Alt-ArrowUp', run: goToPreviousChunk }])), // as in WinMerge
    EditorView.updateListener.of((u) => { if (u.docChanged) onDiffChange(); }),
  ];
  const [a, b] = [left, right].map((side) => codeSetup({ wrap, ...side }));
  const merge = new MergeView({
    parent,
    a: { doc: left.text, extensions: [a.extensions, shared] },
    b: { doc: right.text, extensions: [b.extensions, shared] },
  });
  merge.dom.classList.add('ms-scroll');
  merge.a.dom.addEventListener('focusin', left.onFocus);
  merge.b.dom.addEventListener('focusin', right.onFocus);
  return {
    differences: () => merge.chunks.length,
    destroy: () => merge.destroy(),
    editors: [editorApi(merge.a, a, left.name, onDestroy), editorApi(merge.b, b, right.name, onDestroy)],
  };
}

function editorApi(view, { wrapping, language, spelling }, name, destroy) {
  const setLanguage = (fileName) => {
    const found = LanguageDescription.matchFilename(languages, fileName);
    if (!found) { view.dispatch({ effects: language.reconfigure([]) }); return; }
    found.load().then((support) => view.dispatch({ effects: language.reconfigure(support) })).catch(() => {});
  };
  setLanguage(name);

  return {
    kind: 'code',
    getText: () => view.state.doc.toString(),
    /**
     * Replaces the text as one undo step of its own, not merged with the paste just before it, so a formatter can be taken back alone.
     * Only the part that differs is replaced: replacing everything sends the cursor and the view to the top.
     */
    setText(next) {
      const { from, toA, toB } = changedSpan(view.state.doc.toString(), next);
      const changes = view.state.changes({ from, to: toA, insert: next.slice(from, toB) });
      view.dispatch({ changes, selection: view.state.selection.map(changes, 1), annotations: isolateHistory.of('full') });
    },
    setRename: setLanguage,
    focus: () => view.focus(),
    destroy,
    setWrap: (on) => view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) }),
    setSpellcheck: (on) => view.dispatch({ effects: spelling.reconfigure(on ? EditorView.contentAttributes.of({ spellcheck: 'true' }) : []) }),
    position() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const cursors = view.state.selection.ranges.length;
      return `${t('Z {line}, S {column}', { line: line.number, column: head - line.from + 1 })}${cursors > 1 ? ` · ${t('{n} Cursor', { n: cursors })}` : ''} · ${count(view.state.doc.lines, t('Zeile'), t('Zeilen'))}`;
    },
    /** Applies fn to the selection, or to the whole text if nothing is selected. */
    transform(fn) {
      const { state } = view;
      const sel = state.selection.main;
      const from = sel.empty ? 0 : sel.from;
      const to = sel.empty ? state.doc.length : sel.to;
      view.dispatch({ changes: { from, to, insert: fn(state.sliceDoc(from, to)) }, userEvent: 'input' });
    },
    changeLines: (fn) => changeLines(view, fn),
    transformCase: (fn) => {
      const { state } = view;
      view.dispatch(state.changeByRange((r) => {
        const out = fn(state.sliceDoc(r.from, r.to));
        return { changes: { from: r.from, to: r.to, insert: out }, range: EditorSelection.range(r.from, r.from + out.length) };
      }));
    },
    find: () => { openSearchPanel(view); },
    jumpToDifference: (step) => (step > 0 ? goToNextChunk : goToPreviousChunk)(view),
    goTo(line, column = 1) {
      const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
      const pos = Math.min(l.from + column - 1, l.to);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    },
    getCursor: () => ({ pos: view.state.selection.main.head, scroll: view.scrollDOM.scrollTop }),
    setCursor({ pos = 0, scroll = 0 } = {}) {
      view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) } });
      requestAnimationFrame(() => { view.scrollDOM.scrollTop = scroll; });
    },
  };
}
