// Resizes the textures inside aircraft GLBs for real-time use:
//
//   pnpm --filter @windowseat/client optimize-models
//
// Reads client/models-src/*.glb (originals, not deployed) and writes
// client/public/models/<name>.glb with the base color texture at most
// 2048 px and the other maps (metal/roughness, normal) at most 1024 px.
// 4096² textures cost ~85 MB of GPU memory each (with mipmaps), stalled the
// frame they were first uploaded, and exhausted memory on phones.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, '../models-src')
const OUT = resolve(here, '../public/models')
const BASE_MAX = 2048
const OTHER_MAX = 1024

function parseGlb(buffer) {
  const jsonLength = buffer.readUInt32LE(12)
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'))
  const binStart = 20 + jsonLength + 8
  const binLength = buffer.readUInt32LE(20 + jsonLength)
  return { json, bin: buffer.subarray(binStart, binStart + binLength) }
}

function buildGlb(json, bin) {
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPadded = Buffer.concat([jsonBuffer, Buffer.alloc((4 - (jsonBuffer.length % 4)) % 4, 0x20)])
  const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonPadded.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(binPadded.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded])
}

for (const file of readdirSync(SRC).filter(f => f.endsWith('.glb'))) {
  const { json, bin } = parseGlb(readFileSync(resolve(SRC, file)))
  // Which images are base color textures.
  const baseImages = new Set()
  for (const material of json.materials ?? []) {
    const index = material.pbrMetallicRoughness?.baseColorTexture?.index
    if (index != null) baseImages.add(json.textures[index].source)
  }
  // Re-pack every buffer view, replacing image data with resized JPEGs.
  const parts = []
  let offset = 0
  const imageViews = new Map((json.images ?? []).map((image, i) => [image.bufferView, i]))
  for (let v = 0; v < json.bufferViews.length; ++v) {
    const view = json.bufferViews[v]
    let data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    const imageIndex = imageViews.get(v)
    if (imageIndex != null) {
      const max = baseImages.has(imageIndex) ? BASE_MAX : OTHER_MAX
      data = await sharp(data)
        .resize(max, max, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer()
      json.images[imageIndex].mimeType = 'image/jpeg'
    }
    const padding = (4 - (offset % 4)) % 4
    if (padding > 0) {
      parts.push(Buffer.alloc(padding))
      offset += padding
    }
    view.byteOffset = offset
    view.byteLength = data.length
    parts.push(data)
    offset += data.length
  }
  const newBin = Buffer.concat(parts)
  json.buffers[0].byteLength = newBin.length
  const out = buildGlb(json, newBin)
  writeFileSync(resolve(OUT, basename(file)), out)
  console.info(`${file}: ${(bin.length / 1e6).toFixed(1)} MB -> ${(newBin.length / 1e6).toFixed(1)} MB`)
}
