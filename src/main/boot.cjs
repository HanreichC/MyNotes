// What has to happen before Electron's ready event, which an ES module loaded with import() cannot promise.
const { app, protocol } = require('electron');
const os = require('node:os');
const path = require('node:path');

app.setPath('userData', process.env.MYNOTES_DATA ?? (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'MyNotes')
  : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'MyNotes')));
protocol.registerSchemesAsPrivileged([{ scheme: 'mynotes', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

import('./index.js').catch((e) => { console.error(e); app.exit(1); });
