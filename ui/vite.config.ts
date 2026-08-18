import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Static assets only: `field ui` serves dist/ itself and owns the
// WebSocket, so there is no proxy target to configure here — dev mode
// against a running server is `vite` plus the printed URL's token.
export default defineConfig({
  plugins: [react()],
});
