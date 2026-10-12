import type { Material, WebGLProgramParametersWithUniforms } from 'three'

import {
  bindWaterMaskUniforms,
  WATER_MASK_MATERIAL_CHUNK,
  waterSurfaceUniforms
} from './waterSurface'

export type WaterMaskMaterialMode = 'cutout' | 'surface'

const VERSION = 1
const MARKER = '/* window-seat water geometry */'

/**
 * Makes Google geometry disappear inside mapped water, or clips the inverse
 * on the replacement sea-level mesh. Both paths share the exact same mask.
 */
export function patchWaterMaskMaterial(
  material: Material,
  mode: WaterMaskMaterialMode
): void {
  const state = material.userData as { waterMaskMaterial?: string }
  const key = `${mode}:${VERSION}`
  if (state.waterMaskMaterial === key) return
  state.waterMaskMaterial = key

  const previousCompile = material.onBeforeCompile.bind(material)
  const previousCacheKey = material.customProgramCacheKey.bind(material)
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer)
    bindWaterMaskUniforms(shader.uniforms)
    if (mode === 'surface') {
      shader.uniforms.waterSeaLevel = waterSurfaceUniforms.waterSeaLevel
      shader.uniforms.waterGeometryAnchor = waterSurfaceUniforms.waterGeometryAnchor
      shader.uniforms.waterGeometryEast = waterSurfaceUniforms.waterGeometryEast
      shader.uniforms.waterGeometryNorth = waterSurfaceUniforms.waterGeometryNorth
    }

    shader.vertexShader = patchVertexShader(shader.vertexShader, mode)
    shader.fragmentShader = patchFragmentShader(shader.fragmentShader, mode)
  }
  material.customProgramCacheKey = () =>
    `${previousCacheKey()}|window-seat-water-${key}`
  material.needsUpdate = true
}

function patchVertexShader(
  source: string,
  mode: WaterMaskMaterialMode
): string {
  if (source.includes(MARKER)) return source
  const declarations = /* glsl */ `
${MARKER}
varying vec3 vSemanticWaterPosition;
${
  mode === 'surface'
    ? `uniform float waterSeaLevel;
uniform vec3 waterGeometryAnchor;
uniform vec3 waterGeometryEast;
uniform vec3 waterGeometryNorth;`
    : ''
}
`
  let result = source.replace(/void\s+main\s*\(\s*\)\s*\{/, `${declarations}\n$&`)
  if (mode === 'surface') {
    result = result.replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
// Plane vertices are local tangent offsets. Project them radially back onto
// WGS84 so this dense local patch follows the globe instead of being a plane.
const vec3 waterRadii = vec3(6378137.0, 6378137.0, 6356752.314245);
vec3 waterApprox = waterGeometryAnchor
  + waterGeometryEast * position.x
  + waterGeometryNorth * position.y;
vec3 waterInvRadiiSquared = 1.0 / (waterRadii * waterRadii);
transformed = waterApprox * inversesqrt(dot(waterApprox * waterApprox, waterInvRadiiSquared));
vec3 waterUp = normalize(transformed * waterInvRadiiSquared);
transformed += waterUp * waterSeaLevel * 1000.0;`
    )
  }
  return result.replace(
    '#include <project_vertex>',
    /* glsl */ `vSemanticWaterPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
#include <project_vertex>`
  )
}

function patchFragmentShader(
  source: string,
  mode: WaterMaskMaterialMode
): string {
  if (source.includes(MARKER)) return source
  const test =
    mode === 'cutout'
      ? 'if (semanticWater > 0.5) discard;'
      : 'if (semanticWater <= 0.5) discard;'
  const declarations = /* glsl */ `
${MARKER}
varying vec3 vSemanticWaterPosition;
${WATER_MASK_MATERIAL_CHUNK}
`
  return source.replace(
    /void\s+main\s*\(\s*\)\s*\{/,
    /* glsl */ `${declarations}
$&
  float semanticWater = semanticWaterAtOffset(
    vSemanticWaterPosition - waterCameraPosition
  );
  ${test}`
  )
}

/** Exposed only for shader-contract tests. */
export function compileWaterMaskShaderForTest(
  material: Material,
  mode: WaterMaskMaterialMode,
  shader: WebGLProgramParametersWithUniforms
): void {
  patchWaterMaskMaterial(material, mode)
  material.onBeforeCompile(shader, null as never)
}
