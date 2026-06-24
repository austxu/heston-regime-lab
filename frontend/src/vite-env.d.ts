/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cross-origin API base, e.g. http://localhost:8000. Empty = same-origin (proxied). */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
