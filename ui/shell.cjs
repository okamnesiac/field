// The desktop shell: `field ui` launches this with the session URL, and
// it opens one plain window on it. CommonJS on purpose — Electron's main
// process is CJS, and this file is small enough that a build step for it
// would cost more than it saves.
//
// Two things make it worth having over a browser tab, beyond not being
// one. The window is the app: no tabs, no address bar, its own taskbar
// entry, and closing it ends the session. And the renderer's console is
// mirrored to the terminal `field ui` was launched from — a blank window
// in a shell has no devtools to open, so the diagnosis has to come out
// somewhere a person is already looking.
const { app, BrowserWindow, shell } = require('electron');

// Its own profile directory, so Chromium's caches land somewhere
// writable instead of failing noisily against a default path this
// process may not own — the "Unable to move the cache" spew is the
// symptom, and it drowns the page console this shell exists to surface.
// `field ui` makes it fresh with mkdtemp, hands it over as
// FIELD_UI_PROFILE, and removes it after this process exits: removing it
// here, on quit, would race Chromium, which still holds its files open
// then, and Windows refuses to delete an open file.
const profile = process.env.FIELD_UI_PROFILE;
if (!profile) {
  process.stderr.write('field ui shell: FIELD_UI_PROFILE is not set\n');
  app.exit(1);
} else {
  app.setPath('userData', profile);
}
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// The session URL arrives in the environment, not on the command line:
// it carries the session token, and a process's arguments are readable
// by other users on a shared machine (/proc on Linux, ps everywhere).
const url = process.env.FIELD_UI_URL;
if (!url) {
  process.stderr.write('field ui shell: FIELD_UI_URL is not set\n');
  app.exit(1);
}

// Deliberately no single-instance lock: every `field ui` launch is its
// own session on its own port with its own token, so two projects open
// at once is an ordinary thing to want, and a lock would let whichever
// window opened first silently swallow the second one's launch.

function create() {
  const win = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 620,
    backgroundColor: '#14161a', // paints before the page does, so no white flash
    title: 'field',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // The timeline is the app's body and wants the whole screen; anyone
  // who prefers a smaller window un-maximizes once and Windows
  // remembers nothing, which is fine — full is the right default.
  win.maximize();

  // Electron moved this event from positional arguments to a details
  // object; accept both so the mirror survives an Electron bump, which
  // is exactly the kind of break that would otherwise show up as the
  // silence this hook exists to prevent.
  const levels = ['debug', 'info', 'warning', 'error'];
  win.webContents.on('console-message', (...args) => {
    const [first, level, message, line, source] = args;
    const d = first && typeof first === 'object' && 'message' in first ? first : undefined;
    const text = d ? d.message : message;
    const lvl = d ? d.level : (levels[level] ?? level);
    const src = d ? d.sourceId : source;
    const ln = d ? d.lineNumber : line;
    process.stderr.write(`[page ${lvl}] ${text}${src ? ` (${src}:${ln})` : ''}\n`);
  });
  win.webContents.on('did-fail-load', (_e, code, description, failedUrl) => {
    process.stderr.write(`[shell] failed to load ${failedUrl}: ${description} (${code})\n`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    process.stderr.write(`[shell] renderer gone: ${details.reason}\n`);
  });

  // Anything that is not this session opens in the real browser, so a
  // documentation link cannot navigate the app away from itself. Only
  // web links leave: openExternal hands any scheme to the OS, and a
  // file: or custom-protocol URL is a launcher, not a link.
  const web = (target) => {
    try {
      return ['http:', 'https:'].includes(new URL(target).protocol);
    } catch {
      return false;
    }
  };
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (web(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  // The window stays on the session: a navigation to anywhere but the
  // origin it was opened on goes to the browser instead, or nowhere.
  const origin = new URL(url).origin;
  win.webContents.on('will-navigate', (event, target) => {
    let same = false;
    try {
      same = new URL(target).origin === origin;
    } catch {
      same = false;
    }
    if (same) return;
    event.preventDefault();
    if (web(target)) void shell.openExternal(target);
  });

  void win.loadURL(url);
  return win;
}

app.whenReady().then(() => {
  create();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) create();
  });
});

// Closing the window ends the session on every platform, including
// macOS: this window IS the app, and a field ui with no window is a
// server nobody can reach.
app.on('window-all-closed', () => app.quit());
