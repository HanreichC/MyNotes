// The Notepad++ half: CodeMirror keeps text exactly as it is. For code, JSON, plain text and Markdown source.
import { copyLineDown, deleteLine, moveLineDown, moveLineUp } from '@codemirror/commands';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { gotoLine, openSearchPanel, search } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { basicSetup } from 'codemirror';

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: 'var(--ms-color-system-purple)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--ms-color-system-green)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--ms-color-system-orange)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--ms-color-label-secondary)', fontStyle: 'italic' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--ms-color-accent-text)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.typeName, t.className, t.tagName], color: 'var(--ms-color-system-teal)' },
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--ms-color-accent-text)', textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--ms-color-system-red)' },
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

const german = EditorState.phrases.of({
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

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

export const lineCommands = {
  sortAsc: (lines) => [...lines].sort(collator.compare),
  sortDesc: (lines) => [...lines].sort((a, b) => collator.compare(b, a)),
  unique: (lines) => [...new Set(lines)],
  trimEnd: (lines) => lines.map((l) => l.trimEnd()),
  dropEmpty: (lines) => lines.filter((l) => l.trim()),
};

export function createCodeEditor({ parent, text, name, wrap, onChange, onCursor }) {
  const wrapping = new Compartment();
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        Prec.high(keymap.of([
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
        wrapping.of(wrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange();
          if (u.docChanged || u.selectionSet) onCursor();
        }),
        EditorView.contentAttributes.of({ 'aria-label': 'Code-Editor' }),
      ],
    }),
  });

  const setLanguage = (fileName) => {
    const found = LanguageDescription.matchFilename(languages, fileName);
    if (!found) { view.dispatch({ effects: language.reconfigure([]) }); return; }
    found.load().then((support) => view.dispatch({ effects: language.reconfigure(support) })).catch(() => {});
  };
  setLanguage(name);

  return {
    kind: 'code',
    getText: () => view.state.doc.toString(),
    /** Replaces everything but stays one undo step, so a formatter can be taken back. */
    setText(next) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } }); },
    setRename: setLanguage,
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    setWrap: (on) => view.dispatch({ effects: wrapping.reconfigure(on ? EditorView.lineWrapping : []) }),
    position() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const count = view.state.selection.ranges.length;
      return `Z ${line.number}, S ${head - line.from + 1}${count > 1 ? ` · ${count} Cursor` : ''}`;
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
