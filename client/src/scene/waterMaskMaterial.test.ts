import { MeshBasicMaterial, type WebGLProgramParametersWithUniforms } from 'three'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

function shader(): WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: `void main() {
#include <begin_vertex>
#include <project_vertex>
}`,
    fragmentShader: 'void main() {}'
  } as unknown as WebGLProgramParametersWithUniforms
}

describe('semantic water geometry shader contract', () => {
  beforeAll(() => {
    vi.stubGlobal('window', {
      location: { search: '' },
      localStorage: { getItem: () => null, setItem: () => undefined },
      matchMedia: () => ({ matches: false }),
      screen: { width: 1280, height: 800 }
    })
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: () => null })
    })
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('cuts semantic water out of photogrammetry tiles', async () => {
    const { compileWaterMaskShaderForTest } = await import('./waterMaskMaterial')
    const material = new MeshBasicMaterial()
    const value = shader()
    compileWaterMaskShaderForTest(material, 'cutout', value)

    expect(value.vertexShader).toContain('vSemanticWaterPosition')
    expect(value.fragmentShader).toContain('semanticWaterAtOffset')
    expect(value.fragmentShader).toContain('semanticWater > 0.5')
    expect(value.uniforms.waterTileMap).toBeDefined()
  })

  it('projects replacement water onto WGS84 and clips land', async () => {
    const { compileWaterMaskShaderForTest } = await import('./waterMaskMaterial')
    const material = new MeshBasicMaterial()
    const value = shader()
    compileWaterMaskShaderForTest(material, 'surface', value)

    expect(value.vertexShader).toContain('waterRadii')
    expect(value.vertexShader).toContain('waterSeaLevel * 1000.0')
    expect(value.fragmentShader).toContain('semanticWater <= 0.5')
    expect(value.uniforms.waterGeometryAnchor).toBeDefined()
  })
})
