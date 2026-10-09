import {
  MeshStandardMaterial,
  Uniform,
  Vector3,
  type MeshStandardMaterialParameters
} from 'three'

/**
 * Aircraft materials are lit by SunLight/SkyLight (light sources, not post
 * lighting). A shading vector carries:
 *   x: emissive marker glow (distant icons at night),
 *   y: sun visibility (Earth's shadow, which three.js lights don't know),
 *   z: sky-light scale relative to where the SkyLight probe sits.
 * Instanced meshes read it from an `instanceShading` attribute; single
 * meshes from a per-material uniform (`userData.shading`).
 */
export function patchAircraftMaterial(material: MeshStandardMaterial, instanced: boolean): void {
  const shading = new Uniform(new Vector3(0, 1, 1))
  material.userData.shading = shading
  const previous = material.onBeforeCompile.bind(material)
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer)
    shader.uniforms.aircraftShading = shading
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${instanced ? 'attribute vec3 instanceShading;' : 'uniform vec3 aircraftShading;'}
varying vec3 vShading;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vShading = ${instanced ? 'instanceShading' : 'aircraftShading'};`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShading;')
      .replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= vShading.y;'
      )
      .replace(
        'irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );',
        'irradiance += getLightProbeIrradiance( lightProbe, geometryNormal ) * vShading.z;'
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vShading.x;'
      )
  }
  const key = `aircraft-${instanced ? 'i' : 's'}`
  const previousKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${previousKey()}-${key}`
  material.needsUpdate = true
}

export function createAircraftMaterial(
  parameters: MeshStandardMaterialParameters = {},
  instanced = true
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.3,
    flatShading: true,
    vertexColors: true,
    ...parameters
  })
  patchAircraftMaterial(material, instanced)
  return material
}

/** The shading uniform of a patched single-mesh material, if any. */
export function shadingUniform(material: unknown): Uniform<Vector3> | null {
  if (material instanceof MeshStandardMaterial) {
    const shading = material.userData.shading as Uniform<Vector3> | undefined
    return shading ?? null
  }
  return null
}
