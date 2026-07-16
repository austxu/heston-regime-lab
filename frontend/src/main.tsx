import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App'
import { queryClient } from './lib/queryClient'
import { DataModeProvider } from './lib/dataMode'
import { ErrorBoundary } from './components/ui/ErrorBoundary'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root application mount point')

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DataModeProvider>
        <ErrorBoundary label="the application">
          <App />
        </ErrorBoundary>
      </DataModeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
