import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { exposeStores } from './dev/exposeStores'

import './styles.css'

if (import.meta.env.DEV) {
  exposeStores()
  void import('./dev/clientDiagnostics').then(({ startClientDiagnostics }) => {
    startClientDiagnostics()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
