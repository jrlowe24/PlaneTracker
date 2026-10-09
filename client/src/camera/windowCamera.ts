import { DEG } from '@windowseat/shared'
import { Matrix4, Vector3, type Quaternion } from 'three'

import { AIRFRAMES, type AirframeParams } from '../aircraft/airframes'
import type { Pose } from '../aircraft/pose'
import { aircraftClass } from '../aircraft/typeClasses'
import { airframeScale, scaledAirframe } from '../aircraft/typeDimensions'
import { flightConnection } from '../data/flightConnection'
import { cameraModeStore } from '../state/cameraMode'

/** Mouse-look offsets in the window view, degrees. */
export interface WindowLook {
  yaw: number
  pitch: number
}

export interface SeatGeometry {
  /** Body-frame eye position (meters; +X left, +Y up, +Z forward). */
  x: number
  y: number
  z: number
  /** How far the default view turns toward the nose, degrees. */
  forwardBias: number
  /** Default downward look, degrees. */
  downward: number
}

/**
 * An over-the-wing window seat: eye about a meter above the wing root,
 * over mid-chord, looking out nearly perpendicular and slightly down, so
 * the wing (and an underwing engine) fills the lower part of the view —
 * the classic over-the-wing window view.
 */
export function seatFor(params: AirframeParams, side: 'left' | 'right'): SeatGeometry {
  const sign = side === 'left' ? 1 : -1
  const r = params.fuselageRadius
  const isHeli = params.rotorDiameter != null
  return {
    x: sign * Math.max(0.3, r - 0.4),
    // Seated eye height relative to the fuselage axis.
    y: isHeli ? 0.1 : r * 0.3,
    z: isHeli ? params.length * 0.15 : params.wingRootZ - params.wingRootChord * 0.55,
    forwardBias: isHeli ? 0 : 10,
    downward: params.wingMount > 0.5 ? 2 : 4
  }
}

export function seatForAircraft(hex: string | null, side: 'left' | 'right'): SeatGeometry {
  const state = hex == null ? undefined : flightConnection.registry.byHex.get(hex)?.state
  const cls = aircraftClass(state?.typeCode ?? null, state?.category ?? null)
  const scale = airframeScale(state?.typeCode ?? null, cls)
  return seatFor(scaledAirframe(AIRFRAMES[cls], scale), side)
}

const eye = new Vector3()
const direction = new Vector3()
const target = new Vector3()
const lookMatrix = new Matrix4()

/**
 * Camera pose for a passenger window: rigidly attached to the aircraft body
 * frame (so it pitches and banks with the aircraft), looking ~90° out of the
 * side, turned slightly toward the nose and down, plus limited mouse-look.
 */
export function windowCameraPose(
  pose: Pose,
  side: 'left' | 'right',
  look: WindowLook,
  outPosition: Vector3,
  outQuaternion: Quaternion
): void {
  const seat = seatForAircraft(cameraModeStore.get().targetHex, side)
  const sign = side === 'left' ? 1 : -1
  eye
    .copy(pose.position)
    .addScaledVector(pose.left, seat.x)
    .addScaledVector(pose.up, seat.y)
    .addScaledVector(pose.forward, seat.z)
  // Outward, turned toward the nose by forwardBias + yaw, then down.
  const yaw = (90 - seat.forwardBias - look.yaw * sign) * DEG
  const pitch = (-seat.downward + look.pitch) * DEG
  direction
    .set(0, 0, 0)
    .addScaledVector(pose.forward, Math.cos(yaw) * Math.cos(pitch))
    .addScaledVector(pose.left, sign * Math.sin(yaw) * Math.cos(pitch))
    .addScaledVector(pose.up, Math.sin(pitch))
  target.copy(eye).add(direction)
  lookMatrix.lookAt(eye, target, pose.up)
  outQuaternion.setFromRotationMatrix(lookMatrix)
  outPosition.copy(eye)
}
