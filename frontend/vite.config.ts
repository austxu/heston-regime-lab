import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies API + WebSocket to the FastAPI backend so the frontend can use
// same-origin relative URLs (no CORS in dev). In Docker, nginx does the same proxying.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Plotly's CommonJS trace modules still reference Node's `global`; in browsers the
  // standards-based equivalent is `globalThis`.
  define: { global: 'globalThis' },
  server: {
    port: 5173,
    proxy: {
      '/api-health': {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
})
