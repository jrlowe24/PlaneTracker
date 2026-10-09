import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, type FC } from 'react'
import { Quaternion, Vector3, type PerspectiveCamera } from 'three'

import { FRAME_PRIORITY } from '../aircraft/framePriority'
import type { Pose } from '../aircraft/pose'
import { flightConnection } from '../data/flightConnection'
import { cameraModeStore, type CameraMode } from '../state/cameraMode'
import {
  easeInOutCubic,
  headingFrame,
  lookAtQuaternion,
  orbitPosition,
  setClipPlanes,
  type Orbit
} from './cameraMath'
import { applyJump, takeJump, updatePendingFollow } from './jump'
import { windowCameraPose, type WindowLook } from './windowCamera'

const DEFAULT_FOV = 50
const WINDOW_FOV = 72
const ENTER_DURATION_S = 2.8
const EXIT_DURATION_S = 2.2
const MIN_DISTANCE = 12
const MAX_DISTANCE = 60_000
/** Where the camera ends up when leaving follow mode. */
const EXIT_ORBIT: Orbit = { yaw: 0, pitch: 35, distance: 12_000 }

interface Transition {
  elapsed: number
  duration: number
  /** Start camera position relative to the target at the start. */
  relStart: Vector3
  startQuaternion: Quaternion
  /** Leaving to globe mode: hand over to GlobeControls at the end. */
  exiting: boolean
}

const desiredPosition = new Vector3()
const desiredQuaternion = new Quaternion()
const startPoint = new Vector3()
const relDesired = new Vector3()
const dirStart = new Vector3()
const dirDesired = new Vector3()
const rotation = new Quaternion()
const unitZ = new Vector3()

/**
 * Drives the camera in follow (chase) and window modes and animates the
 * fly-to transitions into and out of them. Runs after the aircraft poses
 * were interpolated for this frame and before instance matrices are built,
 * so the camera and the aircraft always use the same pose (no jitter).
 */
class CameraRigController {
  orbit: Orbit = { yaw: 0, pitch: 10, distance: 110 }
  look: WindowLook = { yaw: 0, pitch: 0 }
  private transition: Transition | null = null
  private activeMode: CameraMode = 'globe'
  private activeHex: string | null = null
  private lastPose: Pose | null = null

  private beginTransition(camera: PerspectiveCamera, target: Vector3, duration: number, exiting: boolean): void {
    this.transition = {
      elapsed: 0,
      duration,
      relStart: camera.position.clone().sub(target),
      startQuaternion: camera.quaternion.clone(),
      exiting
    }
    cameraModeStore.set({ transitioning: true })
  }

  /** Desired camera position/orientation for the current mode and pose. */
  private desired(mode: CameraMode, pose: Pose, exiting: boolean): void {
    if (mode === 'window' && !exiting) {
      windowCameraPose(pose, cameraModeStore.get().windowSide, this.look, desiredPosition, desiredQuaternion)
      return
    }
    const orbit = exiting ? { ...EXIT_ORBIT, yaw: this.orbit.yaw } : this.orbit
    orbitPosition(pose, orbit, desiredPosition)
    lookAtQuaternion(desiredPosition, pose.position, headingFrame(pose).up, desiredQuaternion)
  }

  update(camera: PerspectiveCamera, dt: number): void {
    // A jump (search result, airport shortcut) cuts straight to the globe
    // view over the target, dropping any attachment or transition.
    const jump = takeJump()
    if (jump != null) {
      this.transition = null
      this.activeMode = 'globe'
      this.activeHex = null
      const state = cameraModeStore.get()
      if (state.mode !== 'globe' || state.transitioning) {
        cameraModeStore.set({ mode: 'globe', transitioning: false })
      }
      if (camera.fov !== DEFAULT_FOV) {
        camera.fov = DEFAULT_FOV
        camera.updateProjectionMatrix()
      }
      applyJump(camera, jump)
      return
    }
    updatePendingFollow()

    const { mode, targetHex } = cameraModeStore.get()
    const aircraft = targetHex == null ? undefined : flightConnection.registry.byHex.get(targetHex)
    const pose = aircraft?.pose ?? this.lastPose
    if (aircraft?.pose != null) this.lastPose = aircraft.pose

    // Mode or target changes start transitions.
    if (mode !== this.activeMode || targetHex !== this.activeHex) {
      const wasAttached = this.activeMode !== 'globe'
      const attaching = mode !== 'globe'
      if (mode === 'window' && pose != null) {
        // The window seat is a cut, not a flight: you're simply in the seat.
        this.transition = null
        if (cameraModeStore.get().transitioning) cameraModeStore.set({ transitioning: false })
        this.look = { yaw: 0, pitch: 0 }
      } else if (attaching && pose != null) {
        const switchingView = wasAttached && targetHex === this.activeHex
        this.beginTransition(camera, pose.position, switchingView ? 1.2 : ENTER_DURATION_S, false)
        if (!switchingView && mode === 'follow') {
          this.orbit = { yaw: 0, pitch: 10, distance: 110 }
        }
        this.look = { yaw: 0, pitch: 0 }
      } else if (!attaching && wasAttached && pose != null) {
        this.beginTransition(camera, pose.position, EXIT_DURATION_S, true)
      }
      this.activeMode = mode
      this.activeHex = targetHex
    }

    const transition = this.transition
    if (mode === 'globe' && transition == null) {
      if (camera.fov !== DEFAULT_FOV) {
        camera.fov = DEFAULT_FOV
        camera.updateProjectionMatrix()
      }
      return
    }
    if (pose == null) {
      if (mode !== 'globe') cameraModeStore.set({ mode: 'globe', transitioning: false })
      return
    }

    this.desired(mode, pose, transition?.exiting ?? false)

    if (transition == null) {
      camera.position.copy(desiredPosition)
      camera.quaternion.copy(desiredQuaternion)
    } else {
      transition.elapsed += dt
      const t = Math.min(1, transition.elapsed / transition.duration)
      const e = easeInOutCubic(t)
      // Interpolate around the (moving) target: direction slerp, log distance.
      startPoint.copy(transition.relStart)
      relDesired.copy(desiredPosition).sub(pose.position)
      const d0 = Math.max(1, startPoint.length())
      const d1 = Math.max(1, relDesired.length())
      dirStart.copy(startPoint).divideScalar(d0)
      dirDesired.copy(relDesired).divideScalar(d1)
      rotation.setFromUnitVectors(dirStart, dirDesired)
      rotation.slerpQuaternions(new Quaternion(), rotation, e)
      const distance = Math.exp(Math.log(d0) + (Math.log(d1) - Math.log(d0)) * e)
      camera.position
        .copy(pose.position)
        .add(unitZ.copy(dirStart).applyQuaternion(rotation).multiplyScalar(distance))
      // Turn toward the target early, then track it.
      camera.quaternion.slerpQuaternions(transition.startQuaternion, desiredQuaternion, easeInOutCubic(Math.min(1, t * 1.6)))
      if (t >= 1) {
        this.transition = null
        cameraModeStore.set({ transitioning: false })
      }
    }
    camera.up.copy(headingFrame(pose).up)
    // A face near a cabin window sees a wider field than the default view.
    camera.fov = mode === 'window' && !(transition?.exiting ?? false) ? WINDOW_FOV : DEFAULT_FOV
    // Close objects (the aircraft, its wing from the cabin) need a small near.
    setClipPlanes(camera, mode === 'window' ? 0.3 : Math.max(0.5, Math.min(10, this.orbit.distance * 0.05)))
    camera.updateMatrixWorld()
  }

  onDrag(dx: number, dy: number): void {
    const { mode } = cameraModeStore.get()
    if (mode === 'follow') {
      this.orbit.yaw = (this.orbit.yaw - dx * 0.3) % 360
      this.orbit.pitch = Math.max(-60, Math.min(85, this.orbit.pitch + dy * 0.3))
    } else if (mode === 'window') {
      this.look.yaw = Math.max(-35, Math.min(35, this.look.yaw - dx * 0.15))
      this.look.pitch = Math.max(-25, Math.min(20, this.look.pitch + dy * 0.15))
    }
  }

  onZoom(delta: number): void {
    if (cameraModeStore.get().mode !== 'follow') return
    this.orbit.distance = Math.max(
      MIN_DISTANCE,
      Math.min(MAX_DISTANCE, this.orbit.distance * Math.exp(delta * 0.0015))
    )
  }
}

export const CameraRig: FC = () => {
  const camera = useThree(({ camera }) => camera as PerspectiveCamera)
  const gl = useThree(({ gl }) => gl)
  const rig = useMemo(() => new CameraRigController(), [])

  useFrame((_, delta) => {
    rig.update(camera, Math.min(delta, 0.1))
  }, FRAME_PRIORITY.camera)

  // Pointer input while attached to an aircraft (GlobeControls is disabled).
  useEffect(() => {
    const element = gl.domElement
    let last: { x: number; y: number } | null = null
    const pointers = new Map<number, { x: number; y: number }>()
    let pinch: number | null = null
    const attached = (): boolean => cameraModeStore.get().mode !== 'globe'

    const onDown = (event: PointerEvent): void => {
      if (!attached()) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      last = { x: event.clientX, y: event.clientY }
    }
    const onMove = (event: PointerEvent): void => {
      if (!attached() || !pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinch != null) rig.onZoom((pinch - d) * 4)
        pinch = d
        return
      }
      if (last != null) rig.onDrag(event.clientX - last.x, event.clientY - last.y)
      last = { x: event.clientX, y: event.clientY }
    }
    const onUp = (event: PointerEvent): void => {
      pointers.delete(event.pointerId)
      if (pointers.size < 2) pinch = null
      last = null
    }
    const onWheel = (event: WheelEvent): void => {
      if (!attached()) return
      event.preventDefault()
      rig.onZoom(event.deltaY)
    }
    element.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      element.removeEventListener('wheel', onWheel)
    }
  }, [gl, rig])

  return null
}
