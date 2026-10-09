import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { exposeStores } from './dev/exposeStores'

import './styles.css'

if (import.meta.env.DEV) exposeStores()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
