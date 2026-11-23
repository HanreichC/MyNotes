// Keys on a graphics tablet: models, actions, suggested layout, stored layout. Ported from MyCAD TabletKeys.h.
// Pure logic; reading the keys and running the actions is the renderer's job.

/** What a key does. Command: run once. Hold: run on press and on release (eraser while held: the action toggles on
 *  and back off). Pan: pan the view while the key is held. */
export const Kind = Object.freeze({ None: 0, Command: 1, Hold: 2, Pan: 3 });

// id: stored in the layout; label: English; command: the action the renderer runs (Command, Hold); group: a divider
// in the list where it changes
const a = (id, label, command, kind, group) => Object.freeze({ id, label, command, kind, group });

export const Actions = Object.freeze([
  a('eraser', 'Eraser', 'eraser', Kind.Command, 0),
  a('eraserHold', 'Eraser while held', 'eraser', Kind.Hold, 0),
  a('select', 'Select', 'select', Kind.Command, 0),
  a('pencil', 'Pencil', 'pencil', Kind.Command, 1),
  a('fineliner', 'Fineliner', 'fineliner', Kind.Command, 1),
  a('marker', 'Marker', 'marker', Kind.Command, 1),
  a('color', 'Next Color', 'color', Kind.Command, 1),
  a('undo', 'Undo', 'undo', Kind.Command, 2),
  a('redo', 'Redo', 'redo', Kind.Command, 2),
  a('sheet', 'Only the Sheet', 'sheet', Kind.Command, 3),
  a('look', 'Fit the Sheet', 'look', Kind.Command, 3),
  a('pan', 'Pan View', '', Kind.Pan, 3),
  a('none', 'Nothing', '', Kind.None, 4),
]);

export const action = (id) => Actions.find((x) => x.id === id) ?? Actions[Actions.length - 1]; // Nothing

// match: part of the device name libinput reports (case-insensitive); buttons: keys on the tablet, 0 = unknown, the
// settings page learns them on press
const m = (id, label, match, buttons) => Object.freeze({ id, label, match, buttons });

/** ponytail: only the H640P is checked on the real device (6 keys). The others are recognized by part of their name
 *  and learn their keys on the first press; fill in the key count once someone has the model */
export const Models = Object.freeze([
  m('h430p', 'Huion H430P', 'H430P', 0),
  m('h640p', 'Huion H640P', 'H640P', 6),
  m('h950p', 'Huion H950P', 'H950P', 0),
  m('h1060p', 'Huion H1060P', 'H1060P', 0),
  m('dial', 'Huion Inspiroy Dial', 'Inspiroy Dial', 0),
  m('keydial', 'Huion Inspiroy Keydial', 'Keydial', 0),
  m('intuosS', 'Wacom Intuos S', 'Intuos S', 0),
  m('intuosM', 'Wacom Intuos M', 'Intuos M', 0),
  m('one', 'Wacom One', 'Wacom One', 0),
  m('deco01', 'XP-Pen Deco 01', 'Deco 01', 0),
  m('mini7', 'XP-Pen Deco Mini7', 'Mini7', 0),
  m('g640', 'XP-Pen Star G640', 'G640', 0),
  m('other', 'Other Model', '', 0),
]);

export const model = (id) => Models.find((x) => x.id === id) ?? Models[Models.length - 1]; // Other Model

/** Model for the libinput device name ("HUION Huion Tablet_H640P Pad"), else "Other Model". */
export function detect(deviceName) {
  const name = deviceName.toLowerCase();
  return Models.find((x) => x.match && name.includes(x.match.toLowerCase())) ?? Models[Models.length - 1];
}

/** Keys: "pad1" … "padN" on the tablet (1 = first key, libinput counts from 0), "penLow"/"penHigh" on the pen. */
export const padKey = (n) => `pad${n}`;

const SUGGESTED = new Map([
  ['pad1', 'undo'], ['pad2', 'eraser'], ['pad3', 'select'], ['pad4', 'sheet'],
  ['pad5', 'redo'], ['pad6', 'look'], ['penLow', 'pan'], ['penHigh', 'eraserHold'],
]);

/** Suggested layout (H640P, agreed with the user); further keys of other models: Nothing. */
export const suggestion = (key) => SUGGESTED.get(key) ?? 'none';

/** Layout as stored in the settings: "pad1=undo;penLow=pan", only what differs from the suggestion. Returns a Map. */
export function parse(text) {
  const out = new Map();
  for (const item of text.split(';')) {
    const eq = item.indexOf('=');
    if (eq > 0) out.set(item.slice(0, eq), item.slice(eq + 1));
  }
  return out;
}

export function format(layout) {
  return [...layout]
    .filter(([key, id]) => id !== suggestion(key))
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)) // sorted by key, like std::map
    .map(([key, id]) => `${key}=${id}`)
    .join(';');
}

/** Action of a key: stored, else the suggestion; unknown stored actions count as Nothing. */
export const actionFor = (layout, key) => action(layout.has(key) ? layout.get(key) : suggestion(key));
