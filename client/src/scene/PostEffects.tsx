import { useFrame, useThree } from '@react-three/fiber'
import { SMAA, ToneMapping } from '@react-three/postprocessing'
import type { AerialPerspectiveEffect, LightingMaskPass } from '@takram/three-atmosphere'
import {
  AerialPerspective,
  AtmosphereContext,
  LightingMask
} from '@takram/three-atmosphere/r3f'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'
import {
  EffectMaterial,
  ToneMappingMode,
  type EffectComposer as EffectComposerImpl
} from 'postprocessing'
import { useContext, useEffect, useRef, useState, type FC } from 'react'
import { Uniform, Vector3 } from 'three'

import { AIRCRAFT_LAYER } from '../aircraft/layers'
import { cloudDepth } from '../clouds/cloudDepth'
import { VolumetricClouds } from '../clouds/VolumetricClouds'
import { NightLights } from '../nightLights/NightLights'
import { NIGHT_LIGHT_MAX_EMISSION } from '../nightLights/NightLightsEffect'
import { useStore } from '../state/createStore'
import { QUALITY_PRESETS, qualityStore } from '../state/quality'
import { settingsStore } from '../state/settings'
import { EffectComposer } from './EffectComposer'
import { nightState, updateNightLighting } from './nightLighting'

/**
 * Clouds render at reduced resolution and are upsampled, so cloud behind an
 * aircraft bleeds onto its pixels (a grid of dark/bright lines, worst at
 * night). On aircraft pixels (lighting mask 0), keep the overlay only if
 * the clouds' front-depth buffer has a cloud nearer than the aircraft in
 * the surrounding low-res texels. Cloud front depth is a ray distance, the
 * aircraft's view Z is ≤ its ray distance, so the test is conservative; texels
 * that hit no cloud store the scene's view Z and fail it.
 */
const CLOUD_DEPTH_TEST = /* glsl */ `
/**
 * City light radiance passed in the alpha channel by NightLightsEffect
 * (alpha = 1 − emission / max): warm sodium where dim, whiter LED where
 * bright.
 */
vec3 cityLight(const float alpha) {
  float emission = (1.0 - clamp(alpha, 0.0, 1.0)) * ${NIGHT_LIGHT_MAX_EMISSION.toFixed(3)};
  return emission * mix(vec3(1.0, 0.42, 0.1), vec3(1.0, 0.82, 0.6), smoothstep(0.006, 0.03, emission));
}

bool isAircraftPixel(const vec2 uv) {
  #ifdef HAS_LIGHTING_MASK
  return texture(lightingMaskBuffer, uv).LIGHTING_MASK_CHANNEL_ < 0.5;
  #else
  return false;
  #endif
}

/**
 * Clouds render at half resolution: low-res texels that hit an aircraft
 * carry no cloud, and bilinear upsampling smears them onto the sky or cloud
 * around it — a pale band hugging the silhouette. Next to an aircraft,
 * rebuild the overlay from the surrounding low-res texels that aren't
 * aircraft (bilinear weights renormalized).
 */
vec4 overlayAroundAircraft(const vec2 uv, const vec4 overlay) {
  #if defined(HAS_OVERLAY) && defined(HAS_LIGHTING_MASK)
  ivec2 size = textureSize(overlayBuffer, 0);
  vec2 st = uv * vec2(size) - 0.5;
  ivec2 base = ivec2(floor(st));
  vec2 f = st - vec2(base);
  vec4 sum = vec4(0.0);
  float weightSum = 0.0;
  bool nearAircraft = false;
  for (int y = 0; y <= 1; ++y) {
    for (int x = 0; x <= 1; ++x) {
      ivec2 texel = clamp(base + ivec2(x, y), ivec2(0), size - 1);
      if (isAircraftPixel((vec2(texel) + 0.5) / vec2(size))) {
        nearAircraft = true;
        continue;
      }
      float w = (x == 0 ? 1.0 - f.x : f.x) * (y == 0 ? 1.0 - f.y : f.y);
      sum += w * texelFetch(overlayBuffer, texel, 0);
      weightSum += w;
    }
  }
  return nearAircraft && weightSum > 1e-3 ? sum / weightSum : overlay;
  #else
  return overlay;
  #endif
}

bool cloudInFrontOfAircraft(const vec2 uv) {
  #ifdef HAS_LIGHTING_MASK
  if (hasCloudDepth < 0.5 || !isAircraftPixel(uv)) return true;
  float depth = reverseLogDepth(readDepthValue(depthBuffer, uv), cameraNear, cameraFar);
  float aircraftZ = -getViewZ(depth);
  ivec2 size = textureSize(cloudDepthBuffer, 0);
  ivec2 base = ivec2(floor(uv * vec2(size) - 0.5));
  float front = 1e20;
  for (int y = 0; y <= 1; ++y) {
    for (int x = 0; x <= 1; ++x) {
      float f = texelFetch(cloudDepthBuffer, clamp(base + ivec2(x, y), ivec2(0), size - 1), 0).r;
      if (f > 0.0) front = min(front, f);
    }
  }
  return front < aircraftZ * 0.98;
  #else
  return true;
  #endif
}
`

/**
 * Adds night light to takram's AerialPerspective: ambient irradiance
 * (moonlight + starlight) on lit surfaces and a faint glow behind the
 * stars. Patched into its shader once; values come from nightState.
 */
function patchNightLight(effect: AerialPerspectiveEffect): void {
  const marker = '/* window-seat night light */'
  const source = effect.getFragmentShader()
  if (source == null || source.includes(marker)) return
  const shader = source
    .replace(
      'void mainImage(',
      `${marker}\nuniform vec3 nightAmbient;\nuniform vec3 nightSky;\nuniform sampler2D cloudDepthBuffer;\nuniform float hasCloudDepth;\n${CLOUD_DEPTH_TEST}\nvoid mainImage(`
    )
    // Light shafts are half resolution too: the shadow length behind an
    // aircraft (rays reaching the ground) bleeds onto its pixels as in-
    // scatter stripes. Within the ~1.5 km an aircraft is drawn in detail,
    // shafts in front of it are negligible.
    .replace(
      'shadowLength = texture(shadowLengthBuffer, uv).r;',
      'shadowLength = texture(shadowLengthBuffer, uv).r;\n  if (isAircraftPixel(uv)) shadowLength = 0.0;'
    )
    // Clouds get no light at night from takram (sun and sky only), so they
    // render as black slabs cutting through the scene. Light them with the
    // same moonlight/starlight as the ground (perceptually tuned below their
    // ~0.9 albedo so they read as moonlit, not overcast day), by opacity.
    .replace(
      'vec4 overlay = texture(overlayBuffer, uv);',
      'vec4 overlay = texture(overlayBuffer, uv);\n  if (isAircraftPixel(uv)) {\n    if (!cloudInFrontOfAircraft(uv)) overlay = vec4(0.0);\n  } else {\n    overlay = overlayAroundAircraft(uv, overlay);\n  }\n  overlay.rgb += overlay.a * nightAmbient * 0.35 * RECIPROCAL_PI;'
    )
    .replace(
      'radiance = getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance);',
      'radiance = getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance);\n    radiance += inputColor.rgb * albedoScale * RECIPROCAL_PI * nightAmbient;\n    radiance += cityLight(inputColor.a);'
    )
    // City lights arrive in the alpha channel (NightLightsEffect); terrain
    // is opaque, so restore it.
    .replace('outputColor = vec4(radiance, inputColor.a);', 'outputColor = vec4(radiance, 1.0);')
    .replace(
      '#else // SKY\n    outputColor = inputColor;',
      '#else // SKY\n    outputColor = inputColor;\n    outputColor.rgb += nightSky;'
    )
  if (
    (shader.match(/nightAmbient|nightSky|cloudInFrontOfAircraft|overlayAroundAircraft|cityLight\(|vec4\(radiance, 1\.0\)/g) ?? [])
      .length < 12
  ) {
    // takram's shader changed: night light only partly applied.
    console.warn('[night] AerialPerspective shader patch did not fully apply')
  }
  effect.uniforms.set('nightAmbient', new Uniform(nightState.ambient))
  effect.uniforms.set('nightSky', new Uniform(nightState.sky))
  effect.uniforms.set('cloudDepthBuffer', new Uniform(null))
  effect.uniforms.set('hasCloudDepth', new Uniform(0))
  ;(effect as unknown as { setFragmentShader: (s: string) => void }).setFragmentShader(shader)
}

/**
 * The lighting mask marks aircraft pixels by re-rendering the aircraft
 * layer and keeping pixels where its depth ≤ the scene's depth. The two
 * renders differ by tiny precision errors across the surface, so a strict
 * test fails in stripes and those strips get post-lit like terrain (dark
 * lines at night, bands by day). Allow 0.3% of the distance (20 cm at 70 m);
 * aircraft genuinely behind terrain or buildings are still excluded.
 */
function patchLightingMask(pass: LightingMaskPass): void {
  const material = (
    pass as unknown as {
      depthMaskMaterial?: { fragmentShader: string; needsUpdate: boolean }
    }
  ).depthMaskMaterial
  if (material == null || material.fragmentShader.includes('aircraftDepthTest')) return
  const shader = material.fragmentShader
    .replace(
      'void main() {',
      'bool aircraftDepthTest(const float scene, const float aircraft) {\n  return aircraft <= scene * 1.003 + 1e-7;\n}\n\nvoid main() {'
    )
    .replaceAll('depthTest(depth.x, depth.y)', 'aircraftDepthTest(depth.x, depth.y)')
  if (!shader.includes('aircraftDepthTest(depth.x')) {
    console.warn('[lighting-mask] depth test patch did not apply')
    return
  }
  material.fragmentShader = shader
  material.needsUpdate = true
}

const up = new Vector3()

export const PostEffects: FC = () => {
  const camera = useThree(({ camera }) => camera)
  const { transientStates } = useContext(AtmosphereContext)
  const cloudsEnabled = useStore(qualityStore, s => QUALITY_PRESETS[s.level].clouds !== false)
  const lensFlare = useStore(qualityStore, s => QUALITY_PRESETS[s.level].lensFlare)
  // With clouds, the sky is drawn in post while the sun is up so cloud light
  // shafts reach it; at night the scene Sky + Stars are kept (sky-in-post
  // would replace the stars, and there are no light shafts at night).
  const [sunUp, setSunUp] = useState(true)
  const composerRef = useRef<EffectComposerImpl>(null)
  // The composer is only resized when the canvas size changes, not when
  // the quality preset changes the pixel ratio. Left alone, the effect chain
  // kept rendering at the old (larger) resolution while the canvas and the
  // aircraft lighting mask used the new one: wasted pixels, and the
  // stretched mask blurred into a glow around aircraft.
  const size = useThree(({ size }) => size)
  const dpr = useThree(({ viewport }) => viewport.dpr)
  useEffect(() => {
    composerRef.current?.setSize(size.width, size.height)
  }, [size.width, size.height, dpr])
  const lightingMaskRef = useRef<LightingMaskPass>(null)
  const aerialRef = useRef<AerialPerspectiveEffect>(null)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as { __windowSeatComposer?: EffectComposerImpl | null }
    w.__windowSeatComposer = composerRef.current
    return () => {
      delete w.__windowSeatComposer
    }
  }, [])

  // GlobeControls changes near/far every frame; effects reconstructing
  // positions from depth must use the same values.
  useFrame(({ gl }, delta) => {
    const aerial = aerialRef.current
    if (aerial != null) {
      const depth = aerial.uniforms.get('cloudDepthBuffer')
      if (depth != null) depth.value = cloudDepth.texture
      const has = aerial.uniforms.get('hasCloudDepth')
      if (has != null) has.value = cloudDepth.texture != null ? 1 : 0
    }
    if (transientStates != null) {
      updateNightLighting(
        camera.position,
        transientStates.sunDirection,
        transientStates.moonDirection,
        Math.min(delta, 0.1)
      )
    }
    // Eye adaptation: the exposure setting is the daylight value.
    gl.toneMappingExposure = settingsStore.get().exposure * nightState.exposureGain
    const composer = composerRef.current
    if (composer == null) return
    for (const pass of composer.passes) {
      if (pass.fullscreenMaterial instanceof EffectMaterial) {
        pass.fullscreenMaterial.adoptCameraSettings(camera)
      }
    }
    // The lighting mask compares linearized depths; its material copies the
    // camera's near/far only when the camera is assigned.
    if (lightingMaskRef.current != null) {
      lightingMaskRef.current.mainCamera = camera
    }
    if (transientStates != null) {
      up.copy(camera.position).normalize()
      const nextSunUp = transientStates.sunDirection.dot(up) > -0.05
      if (nextSunUp !== sunUp) setSunUp(nextSunUp)
    }
  })

  return (
    <EffectComposer ref={composerRef} multisampling={0} enableNormalPass>
      {/*
        Mixed lighting: tiles are unlit albedo, lit in post (sunLight/skyLight
        below). Aircraft on AIRCRAFT_LAYER are lit by SunLight/SkyLight light
        sources instead, so they can have specular highlights and emissive
        night markers; the mask keeps post lighting off their pixels. Aerial
        perspective (transmittance + inscatter) still applies to both.
      */}
      <LightingMask
        ref={pass => {
          lightingMaskRef.current = pass
          if (pass != null) patchLightingMask(pass)
        }}
        selectionLayer={AIRCRAFT_LAYER}
      />
      <NightLights />
      <VolumetricClouds />
      <AerialPerspective
        ref={effect => {
          aerialRef.current = effect
          if (effect != null) patchNightLight(effect)
        }}
        sky={cloudsEnabled && sunUp}
        sunLight
        skyLight
        correctGeometricError
        albedoScale={2 / Math.PI}
      />
      <>{lensFlare ? <LensFlare /> : null}</>
      <ToneMapping mode={ToneMappingMode.AGX} />
      <SMAA />
      <Dithering />
    </EffectComposer>
  )
}
