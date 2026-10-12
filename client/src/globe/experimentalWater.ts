import {
  MeshStandardMaterial,
  type MeshBasicMaterial,
  type WebGLProgramParametersWithUniforms
} from 'three'

import { settingsStore } from '../state/settings'

const enabled = { value: settingsStore.get().experimentalWater ? 1 : 0 }

settingsStore.subscribe(() => {
  enabled.value = settingsStore.get().experimentalWater ? 1 : 0
})

/**
 * Prototype water classification from the tile's own imagery and ECEF mesh.
 * It is deliberately conservative and opt-in: blue color, low image detail,
 * a near-sea-level position, and (where available) a nearly horizontal surface
 * must agree.
 */
export function patchExperimentalWater(material: MeshBasicMaterial | MeshStandardMaterial): void {
  if (material.userData.experimentalWaterPatched === true) return
  material.userData.experimentalWaterPatched = true
  const hasPhysicalRoughness = material instanceof MeshStandardMaterial

  const previousCompile = material.onBeforeCompile.bind(material)
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer)
    patchShader(shader, hasPhysicalRoughness)
  }

  const previousKey = material.customProgramCacheKey.bind(material)
  material.customProgramCacheKey = () => `${previousKey()}-experimental-water-v1`
  material.needsUpdate = true
}

function patchShader(shader: WebGLProgramParametersWithUniforms, hasPhysicalRoughness: boolean): void {
  shader.uniforms.experimentalWaterEnabled = enabled

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    `#include <common>
varying vec3 vWaterWorldPosition;${hasPhysicalRoughness ? '\nvarying vec3 vWaterWorldNormal;' : ''}`
  )
  if (hasPhysicalRoughness) {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <skinnormal_vertex>',
      '#include <skinnormal_vertex>\nvWaterWorldNormal = normalize(mat3(modelMatrix) * objectNormal);'
    )
  }
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    '#include <project_vertex>\nvWaterWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;'
  )

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
uniform float experimentalWaterEnabled;
varying vec3 vWaterWorldPosition;
${hasPhysicalRoughness ? 'varying vec3 vWaterWorldNormal;' : ''}

float experimentalWaterConfidence(vec3 albedo) {
  float radius = length(vWaterWorldPosition);
  // Google tiles use Three's Y-up frame with ECEF north mapped onto +Z.
  float sinLatitude = vWaterWorldPosition.z / max(radius, 1.0);
  float cosLatitude = sqrt(max(0.0, 1.0 - sinLatitude * sinLatitude));
  const float EQUATORIAL_RADIUS = 6378137.0;
  const float POLAR_RADIUS = 6356752.314245;
  float ellipsoidRadius = inversesqrt(
    (cosLatitude * cosLatitude) / (EQUATORIAL_RADIUS * EQUATORIAL_RADIUS) +
    (sinLatitude * sinLatitude) / (POLAR_RADIUS * POLAR_RADIUS)
  );
  float altitude = radius - ellipsoidRadius;
  float nearSeaLevel = 1.0 - smoothstep(35.0, 260.0, abs(altitude));
  float horizontalSurface = 1.0;
  ${hasPhysicalRoughness ? 'float radialNormal = abs(dot(normalize(vWaterWorldNormal), normalize(vWaterWorldPosition)));\n  horizontalSurface = smoothstep(0.965, 0.997, radialNormal);' : ''}
  float blueSignal = albedo.b - max(albedo.r, albedo.g);
  float blueWater = smoothstep(0.008, 0.075, blueSignal);
  float imageVariation = length(fwidth(albedo));
  float lowTexture = 1.0 - smoothstep(0.035, 0.16, imageVariation);
  return nearSeaLevel * horizontalSurface * blueWater * mix(0.65, 1.0, lowTexture);
}`
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
float experimentalWater = experimentalWaterConfidence(diffuseColor.rgb) * experimentalWaterEnabled;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.008, 0.055, 0.13), experimentalWater * 0.9);`
    )

  if (hasPhysicalRoughness) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.24, experimentalWater * 0.65);'
    )
  }
}
