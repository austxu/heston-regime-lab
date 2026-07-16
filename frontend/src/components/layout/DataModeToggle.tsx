import { useDataMode } from '../../lib/dataModeContext'

/** Segmented Live / Synthetic switch controlling the whole dashboard's data source. */
export function DataModeToggle() {
  const { preferLive, setPreferLive } = useDataMode()
  return (
    <div
      role="group"
      aria-label="Market data source"
      className="inline-flex items-center rounded-lg border border-edge bg-panel2 p-0.5 text-xs"
    >
      <button
        type="button"
        aria-pressed={preferLive}
        title="Prefer current external market data"
        onClick={() => setPreferLive(true)}
        className={`min-h-7 rounded-md px-2.5 py-1 transition-colors ${
          preferLive ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-ink'
        }`}
      >
        Live
      </button>
      <button
        type="button"
        aria-pressed={!preferLive}
        title="Use the deterministic synthetic dataset"
        onClick={() => setPreferLive(false)}
        className={`min-h-7 rounded-md px-2.5 py-1 transition-colors ${
          !preferLive ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-ink'
        }`}
      >
        Synthetic
      </button>
    </div>
  )
}
