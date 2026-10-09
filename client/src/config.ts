const env = import.meta.env

function flag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

const apiKey = env.VITE_GOOGLE_MAPS_API_KEY?.trim() ?? ''

export const config = {
  googleMapsApiKey: apiKey,
  /** True when Google tiles should not be requested at all. */
  tilesDisabled: flag(env.VITE_DISABLE_TILES) || apiKey === '',
  /** Why tiles are disabled, for the on-screen notice. */
  tilesDisabledReason: flag(env.VITE_DISABLE_TILES)
    ? 'VITE_DISABLE_TILES=1'
    : apiKey === ''
      ? 'VITE_GOOGLE_MAPS_API_KEY is not set'
      : null
} as const
