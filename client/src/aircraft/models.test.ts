import { describe, expect, it } from 'vitest'

import { airlineCode, findModelEntry, type ModelManifest } from './models'

const manifest: ModelManifest = {
  version: 1,
  models: { B738: { url: 'b738.glb' } },
  classes: { narrowbody: { url: 'default.glb' }, widebody: { url: 'widebody.glb' } },
  liveries: {
    DAL: { url: 'delta.glb', classes: { widebody: { url: 'delta-a350.glb' } } },
    ASA: { url: 'alaska.glb' }
  }
}

describe('model selection', () => {
  it('reads airline codes from airline callsigns only', () => {
    expect(airlineCode('DAL1234')).toBe('DAL')
    expect(airlineCode(' asa12 ')).toBe('ASA')
    expect(airlineCode('N123AB')).toBeNull()
    expect(airlineCode(null)).toBeNull()
  })

  it('prefers the airline livery, then type, then class', () => {
    expect(findModelEntry(manifest, 'B738', 'narrowbody', 'DAL5')?.url).toBe('delta.glb')
    expect(findModelEntry(manifest, 'B738', 'narrowbody', 'UAL5')?.url).toBe('b738.glb')
    expect(findModelEntry(manifest, 'A320', 'narrowbody', 'UAL5')?.url).toBe('default.glb')
    // Widebodies: the airline's widebody model, else the class model (not
    // the airline's narrowbody stretched).
    expect(findModelEntry(manifest, 'A359', 'widebody', 'DAL5')?.url).toBe('delta-a350.glb')
    expect(findModelEntry(manifest, 'A359', 'widebody', 'ASA5')?.url).toBe('widebody.glb')
    // Liveries only for airliner classes.
    expect(findModelEntry(manifest, 'C172', 'light', 'DAL5')).toBeNull()
  })
})
