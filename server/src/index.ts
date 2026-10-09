import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

// Milestone 1 stub: accepts WebSocket connections so the client can be wired
// up end-to-end. The adsb.lol poller, viewport merging and replay mode arrive
// in milestone 2.

const PORT = Number(process.env.PORT ?? 8787)

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: http, path: '/ws' })

wss.on('connection', socket => {
  socket.send(JSON.stringify({ type: 'hello', serverTime: Date.now() }))
})

http.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (ws: /ws)`)
})
