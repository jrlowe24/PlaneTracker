import { useFrame, useThree } from '@react-three/fiber'
import { SkyLight, SunLight } from '@takram/three-atmosphere/r3f'
import { ecefToGeodetic } from '@windowseat/shared'
import type { SunDirectionalLight } from '@takram/three-atmosphere'
import { useEffect, useMemo, useRef, type FC } from 'react'
import { Vector3, type Group, type PerspectiveCamera } from 'three'

import { flightConnection } from '../data/flightConnection'
import { computeViewState, type ViewState } from '../data/viewport'
import { cameraModeStore } from '../state/cameraMode'
import { selectionStore } from '../state/selection'
import { AircraftLayer } from './AircraftLayer'
import { DetailedAircraft } from './DetailedAircraft'
import { GroundClamp } from './GroundClamp'
import { lightAnchor } from './lightAnchor'
import { pickAircraft } from './picking'

/** How often the viewport is re-evaluated and, if it moved, sent. */
const VIEWPORT_INTERVAL_S = 0.5

function viewportChanged(a: ViewState, b: ViewState | null): boolean {
  if (b == null) return true
  const moved = a.center.distanceTo(b.center) / 1852
  return (
    moved > Math.max(2, 0.15 * b.radiusNm) ||
    Math.abs(a.radiusNm - b.radiusNm) > 0.2 * b.radiusNm
  )
}

/**
 * Aircraft: data subscription (viewport → server), rendering, lighting and
 * click selection.
 */
export const AircraftSystem: FC = () => {
  const camera = useThree(({ camera }) => camera as PerspectiveCamera)
  const gl = useThree(({ gl }) => gl)

  useEffect(() => {
    flightConnection.start()
  }, [])

  // Viewport reporting.
  const view = useMemo<ViewState>(
    () => ({ lat: 0, lon: 0, radiusNm: 0, center: new Vector3() }),
    []
  )
  const lastSent = useRef<ViewState | null>(null)
  const sinceViewport = useRef(Infinity)
  useFrame((_, delta) => {
    sinceViewport.current += delta
    if (sinceViewport.current < VIEWPORT_INTERVAL_S) return
    sinceViewport.current = 0
    computeViewState(camera, view)
    if (viewportChanged(view, lastSent.current)) {
      lastSent.current = { ...view, center: view.center.clone() }
      flightConnection.setViewport({
        lat: view.lat,
        lon: view.lon,
        radiusNm: view.radiusNm
      })
    }
  })

  // Light sources follow the area being looked at (sun color depends on the
  // observer's position near the terminator; sky light on altitude).
  const sunRef = useRef<SunDirectionalLight>(null)
  const skyGroupRef = useRef<Group>(null)
  useFrame(() => {
    const { mode, targetHex } = cameraModeStore.get()
    const followed =
      mode !== 'globe' && targetHex != null
        ? flightConnection.registry.byHex.get(targetHex)?.pose
        : null
    if (followed != null) {
      // Light the followed aircraft (and the view around it) at its position.
      lightAnchor.copy(followed.position)
    } else {
      computeViewState(camera, view)
      const center = ecefToGeodetic(view.center.x, view.center.y, view.center.z)
      // ~2 km above the ground point.
      lightAnchor
        .copy(view.center)
        .addScaledVector(view.center.clone().normalize(), 2000 - Math.min(0, center.height))
    }
    const sun = sunRef.current
    if (sun != null) {
      sun.target.position.copy(lightAnchor)
      sun.target.updateMatrixWorld()
    }
    const group = skyGroupRef.current
    if (group != null) {
      group.position.copy(lightAnchor)
      group.updateMatrixWorld()
    }
  }, -1)

  // Click (not drag) selects the nearest aircraft under the pointer.
  useEffect(() => {
    const element = gl.domElement
    let down: { x: number; y: number; time: number } | null = null
    const onDown = (event: PointerEvent): void => {
      down = { x: event.clientX, y: event.clientY, time: performance.now() }
    }
    const onUp = (event: PointerEvent): void => {
      if (down == null) return
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y)
      const elapsed = performance.now() - down.time
      down = null
      if (moved > 5 || elapsed > 500) return
      const rect = element.getBoundingClientRect()
      const hex = pickAircraft(
        camera,
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height,
        event.pointerType === 'touch' ? 32 : 22
      )
      selectionStore.set({ selectedHex: hex })
    }
    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointerup', onUp)
    return () => {
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointerup', onUp)
    }
  }, [gl, camera])

  return (
    <>
      <SunLight ref={sunRef} />
      <group ref={skyGroupRef}>
        <SkyLight />
      </group>
      <AircraftLayer />
      <DetailedAircraft />
      <GroundClamp />
    </>
  )
}
