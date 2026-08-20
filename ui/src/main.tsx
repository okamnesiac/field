import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './app.css';

// A blank window is the one failure mode with no diagnosis in it: the
// page cannot say what went wrong, and in a desktop shell there is no
// console to open. So anything that escapes React lands on the page
// itself, and the shell mirrors it to the terminal it was launched from.
function fatal(what: string, detail: unknown): void {
  const message = detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : String(detail);
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML =
      `<pre style="padding:2rem;color:#ff9aa5;white-space:pre-wrap;font:13px ui-monospace,monospace">` +
      `${what}\n\n${message.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</pre>`;
  }
  console.error(what, detail);
}

window.addEventListener('error', (e) => fatal('Uncaught error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => fatal('Unhandled rejection', e.reason));

const container = document.getElementById('root');
if (!container) {
  document.body.textContent = 'field ui: #root is missing from the page';
} else {
  try {
    createRoot(container).render(<App />);
  } catch (err) {
    fatal('React failed to mount', err);
  }
}
