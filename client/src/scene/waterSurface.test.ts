import { AerialPerspectiveEffect } from '@takram/three-atmosphere'
import { describe, expect, it, vi } from 'vitest'

describe('semantic water shader contract', () => {
  it('patches the atmosphere pass idempotently without color classification', async () => {
    vi.stubGlobal('window', {
      location: { search: '' },
      localStorage: { getItem: () => null, setItem: () => undefined },
      matchMedia: () => ({ matches: false }),
      screen: { width: 1280, height: 800 }
    })
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) })
    const { patchWaterSurface } = await import('./waterSurface')
    const effect = new AerialPerspectiveEffect()
    try {
      expect(patchWaterSurface(effect)).toBe(true)
      expect(patchWaterSurface(effect)).toBe(true)
      const shader = effect.getFragmentShader()!
      expect(shader).toContain('/* window-seat semantic water */')
      expect(shader).toContain('texture(waterTileMap')
      expect(shader).toContain('waterSurfaceRadiance(')
      expect(shader).toContain('/ METER_TO_LENGTH_UNIT')
      expect(shader).not.toContain('waterScore(')
      const effectUniforms = effect.uniforms as unknown as Map<string, unknown>
      expect(effectUniforms.get('waterTileMap')).toBeDefined()
    } finally {
      effect.dispose()
      vi.unstubAllGlobals()
    }
  })
})
