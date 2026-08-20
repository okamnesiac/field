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
const { join } = require('node:path');
const { tmpdir } = require('node:os');

// Its own profile directory, so Chromium's caches land somewhere
// writable instead of failing noisily against a default path this
// process may not own — the "Unable to move the cache" spew is the
// symptom, and it drowns the page console this shell exists to surface.
// Per-user, because tmpdir() is shared on Linux: a fixed name there
// belongs to whoever launches first, and the second user's failure
// arrives as exactly the cache noise this line exists to remove.
app.setPath('userData', join(tmpdir(), `field-ui-profile-${process.getuid?.() ?? 'win'}`));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const url = process.argv[2];
if (!url) {
  process.stderr.write('field ui shell: no URL argument\n');
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
  // documentation link cannot navigate the app away from itself.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
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
