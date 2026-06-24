import { useDataMode } from '../../lib/dataMode'

/** Segmented Live / Synthetic switch controlling the whole dashboard's data source. */
export function DataModeToggle() {
  const { preferLive, setPreferLive } = useDataMode()
  return (
    <div className="inline-flex items-center rounded-lg border border-edge bg-panel2 p-0.5 text-xs">
      <button
        onClick={() => setPreferLive(true)}
        className={`rounded-md px-2.5 py-1 transition-colors ${
          preferLive ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-ink'
        }`}
      >
        Live
      </button>
      <button
        onClick={() => setPreferLive(false)}
        className={`rounded-md px-2.5 py-1 transition-colors ${
          !preferLive ? 'bg-sky-500/20 text-sky-300' : 'text-muted hover:text-ink'
        }`}
      >
        Synthetic
      </button>
    </div>
  )
}
