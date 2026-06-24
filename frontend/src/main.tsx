import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App'
import { queryClient } from './lib/queryClient'
import { DataModeProvider } from './lib/dataMode'
import { ErrorBoundary } from './components/ui/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
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
