import {
  MeshStandardMaterial,
  Uniform,
  Vector3,
  type MeshStandardMaterialParameters
} from 'three'

import { MAX_SURFACE_LIGHTS, surfaceLights } from './navLightsStore'

/**
 * Aircraft materials are lit by SunLight/SkyLight (light sources, not post
 * lighting). A shading vector carries:
 *   x: emissive marker glow (distant icons at night),
 *   y: sun visibility (Earth's shadow, which three.js lights don't know),
 *   z: sky-light scale relative to where the SkyLight probe sits.
 * Instanced meshes read it from an `instanceShading` attribute; single
 * meshes from a per-material uniform (`userData.shading`). Single meshes
 * also get `userData.groundLight`: irradiance from street and apron lights
 * around them at night, and the aircraft's own nav lights, beacons and
 * strobes light the surfaces around them (navLightsStore.surfaceLights).
 */
/**
 * Point lights evaluated in the shader rather than as three.js lights, so
 * the instanced aircraft and every other lit material keep their programs.
 * Positions are camera-relative world; rotated into view space here. The
 * window ends each light's reach smoothly at its range.
 */
const NAV_LIGHTS_FRAGMENT = /* glsl */ `
#if defined( RE_Direct )
for (int i = 0; i < ${MAX_SURFACE_LIGHTS}; ++i) {
  vec4 navPosition = navLightPosition[i];
  if (navPosition.w <= 0.0) continue;
  vec3 toLight = mat3(viewMatrix) * navPosition.xyz - geometryPosition;
  float d2 = dot(toLight, toLight);
  float reach = saturate(1.0 - pow2(d2 / (navPosition.w * navPosition.w)));
  if (reach <= 0.0) continue;
  IncidentLight navLight;
  navLight.direction = toLight * inversesqrt(d2);
  vec4 emission = navLightDirection[i];
  float cone = 1.0;
  if (emission.w > -1.0) {
    vec3 emissionDirection = normalize(mat3(viewMatrix) * emission.xyz);
    cone = smoothstep(
      emission.w,
      mix(emission.w, 1.0, 0.45),
      dot(-navLight.direction, emissionDirection)
    );
  }
  // The lens sits in its housing: no singularity on the surface around it.
  navLight.color = navLightColor[i] * cone * pow2(reach) / max(d2, 0.5);
  navLight.visible = true;
  RE_Direct(navLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  // Real paint and nearby structure scatter a little of the intense lens
  // light even when a facet faces away. This restrained local bounce makes
  // the wingtip/tail visibly pick up the light without turning emissive.
  reflectedLight.indirectDiffuse += material.diffuseColor * navLight.color * 0.12;
}
#endif
#include <lights_fragment_end>`

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
    if (!instanced) {
      shader.uniforms.navLightPosition = { value: surfaceLights.position }
      shader.uniforms.navLightColor = { value: surfaceLights.color }
      shader.uniforms.navLightDirection = { value: surfaceLights.direction }
    }
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
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vShading;\nuniform vec3 aircraftGroundLight;${
          instanced
            ? ''
            : `\nuniform vec4 navLightPosition[${MAX_SURFACE_LIGHTS}];\nuniform vec3 navLightColor[${MAX_SURFACE_LIGHTS}];\nuniform vec4 navLightDirection[${MAX_SURFACE_LIGHTS}];`
        }`
      )
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
      .replace('#include <lights_fragment_end>', instanced ? '#include <lights_fragment_end>' : NAV_LIGHTS_FRAGMENT)
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
