import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Flight data WebSocket. Google tiles are never proxied: the browser
      // talks to tile.googleapis.com directly.
      '/ws': {
        target: 'ws://localhost:8787',
        ws: true
      },
      // Worldwide aircraft search (server-side upstream lookups).
      '/api': 'http://localhost:8787'
    }
  },
  optimizeDeps: {
    // Pre-bundle everything up front. If Vite discovers a dependency lazily
    // (e.g. from the normals worker) it force-reloads the page, and every
    // page load starts a new billable Google tiles session.
    entries: ['index.html', 'src/**/*.worker.ts'],
    // Deep imports aren't discovered by the entry scan; list every one used.
    include: [
      'three/addons/utils/BufferGeometryUtils.js',
      'three/addons/loaders/GLTFLoader.js',
      'three/addons/loaders/DRACOLoader.js',
      '@takram/three-clouds',
      '@takram/three-clouds/r3f'
    ]
  },
  worker: {
    format: 'es'
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
})
