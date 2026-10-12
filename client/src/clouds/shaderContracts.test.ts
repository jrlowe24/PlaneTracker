import { CloudsEffect } from '@takram/three-clouds'
import { describe, expect, it } from 'vitest'

import { patchFarClouds } from './farClouds'
import { patchCloudsMarch } from './marchShader'
import { patchNightClouds } from './nightClouds'
import { patchCloudsResolve, RegionalCoverageController } from './regionalShader'

describe('cloud shader contracts', () => {
  it('patches the installed Takram shaders in production order', () => {
    const effect = new CloudsEffect()
    const regional = new RegionalCoverageController()
    const march = effect.cloudsPass.currentMaterial
    const shadow = effect.shadowPass.currentMaterial
    const resolve = effect.cloudsPass.resolveMaterial

    try {
      expect(regional.patch(march)).toBe(true)
      expect(regional.patch(shadow)).toBe(true)
      expect(patchCloudsMarch(march)).toBe(true)
      expect(patchNightClouds(march)).toBe(true)
      expect(patchFarClouds(march)).toBe(true)
      expect(patchCloudsResolve(resolve)).toBe(true)

      expect(march.fragmentShader).toContain('/* window-seat regional coverage */')
      expect(march.fragmentShader).toContain('/* window-seat refined cloud entry */')
      expect(march.fragmentShader).toContain('/* window-seat night clouds */')
      expect(march.fragmentShader).toContain('/* window-seat far clouds */')
      expect(resolve.fragmentShader).toContain('/* window-seat nan guard */')

      // Every patch is intentionally idempotent because React can re-run refs
      // during development and effects can be recreated after context loss.
      expect(regional.patch(march)).toBe(true)
      expect(patchCloudsMarch(march)).toBe(true)
      expect(patchNightClouds(march)).toBe(true)
      expect(patchFarClouds(march)).toBe(true)
      expect(patchCloudsResolve(resolve)).toBe(true)

      // An already-patched material may outlive its React controller during
      // Fast Refresh or context recovery. Idempotence must also rebind the
      // replacement controller's live uniforms, not merely skip the rewrite.
      const replacement = new RegionalCoverageController()
      try {
        expect(replacement.patch(march)).toBe(true)
        expect(march.uniforms.coverageFallback).toBe(replacement.uniforms.coverageFallback)
      } finally {
        replacement.dispose()
      }
    } finally {
      regional.dispose()
      effect.cloudsPass.dispose()
      effect.shadowPass.dispose()
      effect.dispose()
    }
  })
})
