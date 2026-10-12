type DiagnosticWindow = Window & { __windowSeatDiagnosticsStarted?: boolean }

function printable(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Development-only bridge for errors that exist only after WebGL compilation. */
export function startClientDiagnostics(): void {
  const diagnosticWindow = window as DiagnosticWindow
  if (diagnosticWindow.__windowSeatDiagnosticsStarted) return
  diagnosticWindow.__windowSeatDiagnosticsStarted = true
  let second = 0
  let count = 0
  const report = (kind: string, values: unknown[]): void => {
    const now = Math.floor(performance.now() / 1000)
    if (now !== second) {
      second = now
      count = 0
    }
    if (++count > 12) return
    void fetch('/__dev/client-log', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: `${kind}: ${values.map(printable).join(' ')}`
    }).catch(() => undefined)
  }
  for (const kind of ['error', 'warn', 'info'] as const) {
    const original = console[kind].bind(console)
    console[kind] = (...values: unknown[]) => {
      original(...values)
      report(kind, values)
    }
  }
  window.addEventListener('error', event => {
    report('window.error', [event.error ?? event.message])
  })
  window.addEventListener('unhandledrejection', event => {
    report('unhandledrejection', [event.reason])
  })
}
