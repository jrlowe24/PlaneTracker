/**
 * Fetches and decodes one NASA Black Marble detail tile to one gray byte
 * per pixel, off the main thread (drawing it to a canvas and reading the
 * pixels back took a few ms per tile there, a hitch as tiles streamed in).
 */

export interface LightTileRequest {
  id: number
  url: string
  size: number
}

export interface LightTileResponse {
  id: number
  gray: Uint8Array | null
  error?: string
}

self.onmessage = async (event: MessageEvent<LightTileRequest>) => {
  const { id, url, size } = event.data
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`tile ${response.status}`)
    const bitmap = await createImageBitmap(await response.blob())
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const rgba = ctx.getImageData(0, 0, size, size).data
    const gray = new Uint8Array(size * size)
    for (let p = 0; p < gray.length; ++p) gray[p] = rgba[p * 4]!
    const message: LightTileResponse = { id, gray }
    ;(self as unknown as Worker).postMessage(message, [gray.buffer])
  } catch (error) {
    const message: LightTileResponse = { id, gray: null, error: error instanceof Error ? error.message : String(error) }
    ;(self as unknown as Worker).postMessage(message)
  }
}
