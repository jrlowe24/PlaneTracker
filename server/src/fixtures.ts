import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createGunzip, createGzip, type Gzip } from 'node:zlib'

import type { AircraftTuple } from '@windowseat/shared'

/**
 * Recorded flight data: gzipped NDJSON. The first line is a header, every
 * following line one upstream snapshot. Aircraft are stored as wire tuples
 * with their original (absolute) position timestamps.
 */
export interface FixtureHeader {
  type: 'header'
  version: 1
  name: string
  source: string
  attribution: string
  center: { lat: number; lon: number }
  radiusNm: number
  /** Wall time the recording started (epoch ms). */
  recordedAt: number
  intervalMs: number
}

export interface FixtureFrame {
  type: 'frame'
  /** Milliseconds since `recordedAt` when this snapshot arrived. */
  t: number
  ac: AircraftTuple[]
}

export interface Fixture {
  header: FixtureHeader
  frames: FixtureFrame[]
}

export async function readFixture(path: string): Promise<Fixture> {
  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity
  })
  let header: FixtureHeader | null = null
  const frames: FixtureFrame[] = []
  for await (const line of lines) {
    if (line.trim() === '') continue
    const record = JSON.parse(line) as FixtureHeader | FixtureFrame
    if (record.type === 'header') header = record
    else frames.push(record)
  }
  if (header == null) throw new Error(`${path}: missing header line`)
  frames.sort((a, b) => a.t - b.t)
  return { header, frames }
}

export class FixtureWriter {
  private readonly gzip: Gzip
  private readonly file: WriteStream

  constructor(path: string, header: FixtureHeader) {
    this.gzip = createGzip({ level: 9 })
    this.file = createWriteStream(path)
    this.gzip.pipe(this.file)
    this.gzip.write(JSON.stringify(header) + '\n')
  }

  write(frame: FixtureFrame): void {
    this.gzip.write(JSON.stringify(frame) + '\n')
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => {
      this.file.on('close', resolve)
      this.gzip.end()
    })
  }
}
