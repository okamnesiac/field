import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Static assets only: `field ui` serves dist/ itself and owns the
// WebSocket. There is no dev-server mode against a running `field ui`:
// under `vite` the client would open ws://<vite host>/ws, which nothing
// proxies, and the upgrade's Origin check refuses any page `field ui`
// did not serve. Rebuild with `pnpm --dir ui build` and reload instead.
export default defineConfig({
  plugins: [react()],
});
