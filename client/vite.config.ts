import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** Mirrors browser-only shader/runtime errors into the local dev terminal. */
function clientDiagnostics(): Plugin {
  return {
    name: 'window-seat-client-diagnostics',
    configureServer(server) {
      server.middlewares.use('/__dev/client-log', (request, response, next) => {
        if (request.method !== 'POST') {
          next()
          return
        }
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => {
          if (body.length < 16_000) body += String(chunk).slice(0, 16_000 - body.length)
        })
        request.on('end', () => {
          console.error(`[browser] ${body}`)
          response.statusCode = 204
          response.end()
        })
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), clientDiagnostics()],
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
