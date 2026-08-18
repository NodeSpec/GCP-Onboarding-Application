import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The console is served as static assets by the API service, behind IAP
 * (REQ-011, REQ-032 AC-6). It is built into the API's public/ directory so the
 * one Cloud Run service serves both the API and the operator surface, which is
 * what keeps the console inside the same IAP perimeter as the endpoints it
 * calls rather than needing a second protected origin.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../api/public',
    emptyOutDir: true,
  },
});
