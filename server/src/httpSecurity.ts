/** Maximum accepted WebSocket message size. Client messages are under 200 B. */
export const WS_MAX_PAYLOAD_BYTES = 16 * 1024

/** Parse the comma-separated browser origins accepted by HTTP and WebSocket. */
export function parseAllowedOrigins(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(',')
      .map(origin => origin.trim())
      .filter(origin => origin !== '')
  )
}

/**
 * Missing Origin is allowed for non-browser clients. This is not
 * authentication—callers outside a browser can spoof Origin—but it prevents
 * unrelated sites from driving the public API through a visitor's browser.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowed: ReadonlySet<string>
): boolean {
  return origin == null || origin === '' || allowed.has('*') || allowed.has(origin)
}

export interface MessageRateWindow {
  startedAt: number
  count: number
}

/** Fixed one-second message-rate window for a WebSocket client. */
export function acceptClientMessage(
  window: MessageRateWindow,
  now: number,
  limit: number
): boolean {
  if (now - window.startedAt >= 1000) {
    window.startedAt = now
    window.count = 0
  }
  window.count += 1
  return window.count <= limit
}
