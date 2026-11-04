// MyStyle icons (I-1): 24 grid, 1.8 stroke, round caps, currentColor. Shared symbols come from MyPods (I-4).
const stroke = (d, w = 1.8) => `<g fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</g>`;

const paths = {
  plus: '<rect x="4" y="10.9" width="16" height="2.2" rx="1.1" fill="currentColor"/><rect x="10.9" y="4" width="2.2" height="16" rx="1.1" fill="currentColor"/>',
  minus: '<rect x="4" y="10.9" width="16" height="2.2" rx="1.1" fill="currentColor"/>',
  close: stroke('<path d="M7 7l10 10M17 7 7 17"/>'),
  check: stroke('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.2),
  info: stroke('<circle cx="12" cy="12" r="9.2"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".4"/>'),
  warning: stroke('<path d="M10.3 4.1a2 2 0 0 1 3.4 0l7.6 13.2a2 2 0 0 1-1.7 3H4.4a2 2 0 0 1-1.7-3z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17" r=".4"/>'),
  error: stroke('<circle cx="12" cy="12" r="9.2"/><path d="M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4"/>'),
  link: stroke('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>'),
  chevrons: stroke('<path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4"/>', 2),
  settings: stroke('<path d="M18.98 9.53 L21.37 9.90 L21.37 14.10 L18.98 14.47 L18.68 15.19 L20.11 17.14 L17.14 20.11 L15.19 18.68 L14.47 18.98 L14.10 21.37 L9.90 21.37 L9.53 18.98 L8.81 18.68 L6.86 20.11 L3.89 17.14 L5.32 15.19 L5.02 14.47 L2.63 14.10 L2.63 9.90 L5.02 9.53 L5.32 8.81 L3.89 6.86 L6.86 3.89 L8.81 5.32 L9.53 5.02 L9.90 2.63 L14.10 2.63 L14.47 5.02 L15.19 5.32 L17.14 3.89 L20.11 6.86 L18.68 8.81Z"/><circle cx="12" cy="12" r="3"/>'),
  contrast: '<rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M20.5 7.5v9a4 4 0 0 1-4 4h-9z" fill="currentColor"/>',
  transparency: stroke('<rect x="3.5" y="3.5" width="11" height="11" rx="2.5"/><path d="M14.5 9.5h3.5a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5h-6a2.5 2.5 0 0 1-2.5-2.5v-3.5" stroke-dasharray="2 2.6"/>'),
  motion: stroke('<circle cx="15" cy="12" r="5.5"/><path d="M3 8.5h4.5M2.5 12h4M3 15.5h4.5"/>'),
  theme: stroke('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  glass: stroke('<path d="M12 3.2c3.3 4 6.2 7.3 6.2 10.9a6.2 6.2 0 0 1-12.4 0c0-3.6 2.9-6.9 6.2-10.9z"/><path d="M9.2 14.4a2.9 2.9 0 0 0 2.4 2.7"/>'),
  search: stroke('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20.5 20.5"/>'),
  trash: stroke('<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>'),
  maximize: stroke('<rect x="6" y="6" width="12" height="12" rx="2.5"/>'),
  restore: stroke('<rect x="5" y="9" width="10" height="10" rx="2.5"/><path d="M9 5.5h7a3 3 0 0 1 3 3v7"/>'),
  chevronRight: stroke('<path d="M9.5 6l6 6-6 6"/>', 2),
  chevronDown: stroke('<path d="M6 9.5l6 6 6-6"/>', 2),
  file: stroke('<path d="M6.5 3.5h7L18.5 8.5v12h-12z"/><path d="M13.5 3.5v5h5"/>'),
  fileCode: stroke('<path d="M6.5 3.5h7L18.5 8.5v12h-12z"/><path d="M13.5 3.5v5h5M10.5 12.5 8.5 14.5l2 2M14 12.5l2 2-2 2"/>'),
  folder: stroke('<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  folderPlus: stroke('<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>'),
  history: stroke('<path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4.5l3 2"/>'),
  bold: stroke('<path d="M7.5 5h5.5a3.5 3.5 0 0 1 0 7H7.5zM7.5 12H14a3.5 3.5 0 0 1 0 7H7.5z"/>', 2.2),
  italic: stroke('<path d="M10 5h6M8 19h6M14 5l-4 14"/>'),
  strike: stroke('<path d="M4.5 12h15M16 7.5C15.3 5.8 13.8 5 12 5c-2.4 0-4 1.3-4 3.2 0 1.4.8 2.3 2.2 3M8 16.5c.7 1.7 2.2 2.5 4 2.5 2.4 0 4-1.3 4-3.2 0-.6-.1-1.1-.4-1.5"/>'),
  code: stroke('<path d="M8.5 7l-5 5 5 5M15.5 7l5 5-5 5"/>'),
  table: stroke('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M3.5 10h17M3.5 14.5h17M9.5 10v9"/>'),
};

export const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? ''}</svg>`;
