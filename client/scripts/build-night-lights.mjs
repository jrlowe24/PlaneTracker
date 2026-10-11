// Builds the night-lights data from NASA Black Marble 2016 (grayscale, 500 m):
//
//   pnpm --filter @windowseat/client night-lights
//
// 1. Downloads the eight 21600×21600 source tiles (~150 MB, cached in
//    client/.night-lights-src/).
// 2. Cuts a detail level of 512×512 tiles at ~610 m/px (equirectangular,
//    2.8125° per tile, 128×64 tiles worldwide; empty ocean tiles skipped)
//    into client/public/night-lights/7/{x}_{y}.jpg.
// 3. Writes a global 8192×4096 base image (~5 km/px), a 4096×2048 one for
//    phones, and manifest.json.
//
// Outputs are gitignored (tens of MB). Source: NASA Earth Observatory,
// "Earth at Night" Black Marble 2016 (public domain; credit NASA).
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

sharp.cache(false)
const here = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = resolve(here, '../.night-lights-src')
const OUT_DIR = resolve(here, '../public/night-lights')
const BASE_URL =
  'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144897'

const SOURCE_SIZE = 21_600 // px per 90° source tile
const LEVEL = 7
const TILE = 512
const TILES_PER_SOURCE = 32 // 90° / 2.8125°
const SOURCE_PER_TILE = SOURCE_SIZE / TILES_PER_SOURCE // 675 px → 512 px
const BASE_WIDTH = 8192
const BASE_TILE = BASE_WIDTH / 4 // 2048 px per 90° source tile
const EMPTY_MAX = 4 // tiles whose brightest pixel is ≤ this are skipped

// Columns A–D = lon −180…180 in 90° steps; rows 1 (north) and 2 (south).
const SOURCES = []
for (const [row, rowName] of [[0, '1'], [1, '2']]) {
  for (const [col, colName] of [[0, 'A'], [1, 'B'], [2, 'C'], [3, 'D']]) {
    SOURCES.push({ col, row, file: `BlackMarble_2016_${colName}${rowName}_gray.jpg` })
  }
}

async function download(file) {
  const path = resolve(SRC_DIR, file)
  if (existsSync(path) && statSync(path).size > 1_000_000) return path
  console.info(`Downloading ${file}…`)
  const response = await fetch(`${BASE_URL}/${file}`)
  if (!response.ok || response.body == null) throw new Error(`${response.status} for ${file}`)
  const partial = `${path}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  const { renameSync } = await import('node:fs')
  renameSync(partial, path)
  return path
}

mkdirSync(SRC_DIR, { recursive: true })
mkdirSync(resolve(OUT_DIR, String(LEVEL)), { recursive: true })

const tiles = []
// Global base, assembled in a raw single-channel buffer.
const base = new Uint8Array(BASE_WIDTH * (BASE_WIDTH / 2))
for (const source of SOURCES) {
  const path = await download(source.file)
  console.info(`Tiling ${source.file}…`)
  const { data, info } = await sharp(path, { limitInputPixels: false })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.width !== SOURCE_SIZE || info.height !== SOURCE_SIZE) {
    throw new Error(`${source.file}: unexpected size ${info.width}×${info.height}`)
  }
  const raw = { raw: { width: SOURCE_SIZE, height: SOURCE_SIZE, channels: 1 }, limitInputPixels: false }

  for (let ty = 0; ty < TILES_PER_SOURCE; ++ty) {
    for (let tx = 0; tx < TILES_PER_SOURCE; ++tx) {
      // Cheap emptiness test on the source block before resizing.
      let max = 0
      const x0 = tx * SOURCE_PER_TILE
      const y0 = ty * SOURCE_PER_TILE
      for (let y = y0; y < y0 + SOURCE_PER_TILE && max <= EMPTY_MAX; y += 2) {
        const row = y * SOURCE_SIZE
        for (let x = x0; x < x0 + SOURCE_PER_TILE; x += 2) {
          const v = data[row + x]
          if (v > max) {
            max = v
            if (max > EMPTY_MAX) break
          }
        }
      }
      if (max <= EMPTY_MAX) continue
      const gx = source.col * TILES_PER_SOURCE + tx
      const gy = source.row * TILES_PER_SOURCE + ty
      const out = resolve(OUT_DIR, String(LEVEL), `${gx}_${gy}.jpg`)
      tiles.push(`${gx}_${gy}`)
      if (existsSync(out)) continue
      await sharp(data, raw)
        .extract({ left: x0, top: y0, width: SOURCE_PER_TILE, height: SOURCE_PER_TILE })
        .resize(TILE, TILE, { kernel: 'lanczos3' })
        .jpeg({ quality: 85, mozjpeg: true })
        .toFile(out)
    }
  }
  const part = await sharp(data, raw)
    .resize(BASE_TILE, BASE_TILE, { kernel: 'lanczos3' })
    .greyscale()
    .raw()
    .toBuffer()
  for (let y = 0; y < BASE_TILE; ++y) {
    base.set(
      part.subarray(y * BASE_TILE, (y + 1) * BASE_TILE),
      (source.row * BASE_TILE + y) * BASE_WIDTH + source.col * BASE_TILE
    )
  }
  console.info(`  ${tiles.length} detail tiles so far`)
}

await sharp(base, { raw: { width: BASE_WIDTH, height: BASE_WIDTH / 2, channels: 1 }, limitInputPixels: false })
  .jpeg({ quality: 90, mozjpeg: true })
  .toFile(resolve(OUT_DIR, 'base.jpg'))
// Half size for phones: an 8192×4096 decode is too big for iOS (and 45 MB
// of GPU memory with mipmaps); 4096×2048 is a quarter of both.
await sharp(base, { raw: { width: BASE_WIDTH, height: BASE_WIDTH / 2, channels: 1 }, limitInputPixels: false })
  .resize(BASE_WIDTH / 2, BASE_WIDTH / 4, { kernel: 'lanczos3' })
  .jpeg({ quality: 90, mozjpeg: true })
  .toFile(resolve(OUT_DIR, 'base-small.jpg'))

writeFileSync(
  resolve(OUT_DIR, 'manifest.json'),
  JSON.stringify({
    version: 1,
    source: 'NASA Earth Observatory, Black Marble 2016 (grayscale, 500 m)',
    credit: 'Night lights: NASA Earth Observatory',
    base: { url: 'base.jpg', width: BASE_WIDTH, height: BASE_WIDTH / 2 },
    baseSmall: { url: 'base-small.jpg', width: BASE_WIDTH / 2, height: BASE_WIDTH / 4 },
    detail: {
      level: LEVEL,
      tileSize: TILE,
      tileDegrees: 360 / (TILES_PER_SOURCE * 4),
      columns: TILES_PER_SOURCE * 4,
      rows: TILES_PER_SOURCE * 2,
      tiles: tiles.sort()
    }
  })
)
console.info(`Done: ${tiles.length} detail tiles + base.jpg in ${OUT_DIR}`)
