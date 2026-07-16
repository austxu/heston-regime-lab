import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Short label of what failed, e.g. "the Vol Surface view". */
  label?: string
}

interface State {
  error: Error | null
}

/** Catches render-time errors in a subtree and shows a graceful fallback with retry. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface for debugging; in production this would go to an error reporter.
    console.error('ErrorBoundary caught error', error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="card card-pad">
          <h3 className="text-sm font-semibold text-rose-300">Something went wrong</h3>
          <p className="mt-1 text-xs text-muted">
            {this.props.label ? `Failed to render ${this.props.label}.` : 'A rendering error occurred.'}
          </p>
          <pre className="mt-3 max-h-32 overflow-auto rounded bg-panel2 p-2 text-[11px] text-muted">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={this.reset}
            className="mt-3 rounded-lg border border-edge px-3 py-1.5 text-xs text-ink hover:bg-edge/40"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
