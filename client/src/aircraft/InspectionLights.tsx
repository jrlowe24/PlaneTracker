import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, type FC } from 'react'
import { Group, Object3D, PCFShadowMap, SpotLight, type ShadowMapType, type WebGLRenderer } from 'three'

import { flightConnection } from '../data/flightConnection'
import { cameraModeStore } from '../state/cameraMode'
import { selectionStore } from '../state/selection'
import { nightState } from '../scene/nightLighting'
import { AIRFRAMES } from './airframes'
import { detailedHexes, modelLightAnchors } from './detailState'
import { AIRCRAFT_LAYER } from './layers'
import { nightLightingTestStore } from '../nightLights/nightLightsStore'

function configureShadows(gl: WebGLRenderer, enabled: boolean, type: ShadowMapType): void {
  gl.shadowMap.enabled = enabled
  gl.shadowMap.type = type
}

/** Only the inspected aircraft gets two small real self-shadow maps. */
export const InspectionLights: FC = () => {
  const gl = useThree(s => s.gl)
  const group = useMemo(() => {
    const g = new Group()
    for (let i = 0; i < 2; ++i) {
      const light = new SpotLight(0xfff4e5, 0, 28, Math.PI / 5, 0.8, 2)
      light.layers.set(AIRCRAFT_LAYER)
      light.castShadow = true
      light.shadow.mapSize.set(512, 512)
      light.shadow.camera.near = 0.1
      light.shadow.camera.far = 28
      light.shadow.camera.layers.set(AIRCRAFT_LAYER)
      light.shadow.bias = -0.0002
      light.shadow.normalBias = 0.015
      light.shadow.autoUpdate = false
      light.target = new Object3D()
      g.add(light, light.target)
    }
    return g
  }, [])
  useEffect(() => {
    const enabled = gl.shadowMap.enabled
    const type = gl.shadowMap.type
    configureShadows(gl, true, PCFShadowMap)
    return () => {
      for (const child of group.children) if (child instanceof SpotLight) child.dispose()
      configureShadows(gl, enabled, type)
    }
  }, [gl, group])
  const update = (lights: Group): void => {
    const mode = cameraModeStore.get()
    const hex = mode.mode === 'globe' ? selectionStore.get().selectedHex : mode.targetHex
    const a = hex == null ? undefined : flightConnection.registry.byHex.get(hex)
    const pose = a?.pose
    const anchor = hex == null ? undefined : modelLightAnchors.get(hex)?.wingRoot
    const active = a != null && pose != null && hex != null && detailedHexes.has(hex) &&
      anchor != null && nightState.night > 0 &&
      (pose.onGround ? pose.speed > 2.5 || (import.meta.env.DEV && nightLightingTestStore.get().forceAircraftWorkLights) : a.groundHeight != null && pose.height - a.groundHeight < 3000)
    for (let i = 0; i < 2; ++i) {
      const light = lights.children[i * 2] as SpotLight
      light.intensity = 0
      light.shadow.autoUpdate = false
      if (!active || a == null || pose == null || anchor == null) continue
      const side = i === 0 ? 1 : -1
      const params = AIRFRAMES[a.cls]
      if (params.engines.rearMounted || !params.engines.stations.some(s => s > 0)) continue
      light.position.copy(pose.position)
        .addScaledVector(pose.left, side * anchor.x)
        .addScaledVector(pose.up, anchor.y - 0.05)
        .addScaledVector(pose.forward, anchor.z + 0.35)
      // Forward and outboard from the leading-edge housing, across the
      // inner nacelle and down to the pavement. The mesh blocks the beam.
      light.target.position.copy(light.position)
        .addScaledVector(pose.left, side * 5)
        .addScaledVector(pose.forward, 7)
        .addScaledVector(pose.up, -2)
      light.intensity = 1.8 * nightState.night * pose.opacity
      // Keep castShadow constant to avoid recompiling every aircraft shader
      // whenever a plane stops taxiing; only the two maps' updates toggle.
      light.shadow.autoUpdate = true
      light.target.updateMatrixWorld()
      light.updateMatrixWorld()
    }
  }
  useFrame(() => update(group), 0.1)
  return <primitive object={group} />
}
