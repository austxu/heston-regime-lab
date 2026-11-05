import { defineConfig } from 'vite'

// Static, fully client-side build: no API proxy, no server. Preact JSX via the oxc transform.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    reportCompressedSize: true,
  },
})
