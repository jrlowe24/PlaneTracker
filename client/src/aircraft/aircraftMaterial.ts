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
 * meshes from a per-material uniform (`userData.shading`). Single meshes
 * also get `userData.groundLight`: irradiance from street and apron lights
 * around them at night.
 */
export function patchAircraftMaterial(material: MeshStandardMaterial, instanced: boolean): void {
  const shading = new Uniform(new Vector3(0, 1, 1))
  material.userData.shading = shading
  const groundLight = new Uniform(new Vector3())
  material.userData.groundLight = groundLight
  const previous = material.onBeforeCompile.bind(material)
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer)
    shader.uniforms.aircraftShading = shading
    shader.uniforms.aircraftGroundLight = groundLight
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
      .replace('#include <common>', '#include <common>\nvarying vec3 vShading;\nuniform vec3 aircraftGroundLight;')
      .replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= vShading.y;'
      )
      .replace(
        // Ground bounce (hemisphere light) comes from sunlit ground.
        'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );',
        'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal ) * vShading.y;'
      )
      .replace(
        'irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );',
        'irradiance += getLightProbeIrradiance( lightProbe, geometryNormal ) * vShading.z + aircraftGroundLight;'
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

/** The ground light uniform of a patched single-mesh material, if any. */
export function groundLightUniform(material: unknown): Uniform<Vector3> | null {
  if (material instanceof MeshStandardMaterial) {
    return (material.userData.groundLight as Uniform<Vector3> | undefined) ?? null
  }
  return null
}

/** The shading uniform of a patched single-mesh material, if any. */
export function shadingUniform(material: unknown): Uniform<Vector3> | null {
  if (material instanceof MeshStandardMaterial) {
    const shading = material.userData.shading as Uniform<Vector3> | undefined
    return shading ?? null
  }
  return null
}
