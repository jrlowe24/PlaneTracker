const env = import.meta.env

function flag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

const apiKey = env.VITE_GOOGLE_MAPS_API_KEY?.trim() ?? ''

/**
 * Flight data server origin (e.g. https://windowseat.up.railway.app) when
 * it isn't served from the same origin as the site (static hosting); empty
 * in development (Vite proxies /ws and /api).
 */
const serverUrl = (env.VITE_SERVER_URL?.trim() ?? '').replace(/\/+$/, '')

function serverHttpUrl(path: string): string {
  return serverUrl === '' ? path : `${serverUrl}${path}`
}

function serverWsUrl(path: string): string {
  if (serverUrl === '') {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${protocol}://${window.location.host}${path}`
  }
  return `${serverUrl.replace(/^http/, 'ws')}${path}`
}

export const config = {
  googleMapsApiKey: apiKey,
  serverHttpUrl,
  serverWsUrl,
  /** True when Google tiles should not be requested at all. */
  tilesDisabled: flag(env.VITE_DISABLE_TILES) || apiKey === '',
  /** Why tiles are disabled, for the on-screen notice. */
  tilesDisabledReason: flag(env.VITE_DISABLE_TILES)
    ? 'VITE_DISABLE_TILES=1'
    : apiKey === ''
      ? 'VITE_GOOGLE_MAPS_API_KEY is not set'
      : null
} as const
