import { useFrame } from '@react-three/fiber'
import { AtmosphereContext } from '@takram/three-atmosphere/r3f'
import { useContext, useEffect, useMemo, type FC } from 'react'
import { Group, Matrix4, Mesh, Vector3, type Object3D } from 'three'

import { flightConnection } from '../data/flightConnection'
import { cameraModeStore } from '../state/cameraMode'
import { selectionStore } from '../state/selection'
import { shadingUniform } from './aircraftMaterial'
import { aircraftClass } from './typeClasses'
import { AIRFRAMES, type AircraftClass } from './airframes'
import { detailedHexes, modelLightAnchors } from './detailState'
import { FRAME_PRIORITY } from './framePriority'
import { lightAnchor } from './lightAnchor'
import { createDetailedModel, disposeDetailedModel } from './models'
import { typeDimensions } from './typeDimensions'
import { aircraftShading, skyBrightness } from './shading'

/** Aircraft closer than this get a detailed model instead of an instance. */
const DETAIL_RADIUS = 1500
const MAX_DETAILED = 12

interface DetailedEntry {
  object: Object3D
  /** glTF models are real size; placeholders are scaled to the type. */
  isGltf: boolean
  /** glTF scale to the type's real size (models with `fit`), else 1. */
  fitScale: { span: number; length: number }
  /** Vertical model shift (m, body up) putting its wheels on the ground. */
  lift: number
  cls: AircraftClass
  typeCode: string | null
}

const basis = new Matrix4()
const sun = new Vector3()
const shading = { x: 0, y: 0, z: 0 }

/**
 * Full-detail models for the followed aircraft and aircraft near the camera
 * (glTF from the manifest when available, else the class placeholder at
 * higher tessellation). Their instanced markers are hidden meanwhile.
 */
class DetailedAircraftController {
  readonly group = new Group()
  private readonly entries = new Map<string, DetailedEntry>()

  private wanted(): Set<string> {
    const wanted = new Set<string>()
    const { mode, targetHex } = cameraModeStore.get()
    if (mode !== 'globe' && targetHex != null) wanted.add(targetHex)
    const near = flightConnection.registry.list
      .filter(a => a.cameraDistance < DETAIL_RADIUS && a.pose != null)
      .sort((a, b) => a.cameraDistance - b.cameraDistance)
    for (const aircraft of near) {
      if (wanted.size >= MAX_DETAILED) break
      wanted.add(aircraft.hex)
    }
    return wanted
  }

  private create(hex: string): void {
    const state = flightConnection.registry.byHex.get(hex)?.state
    const typeCode = state?.typeCode ?? null
    const cls = aircraftClass(typeCode, state?.category ?? null)
    const entry: DetailedEntry = {
      isGltf: false,
      fitScale: { span: 1, length: 1 },
      lift: 0,
      cls,
      typeCode,
      object: createDetailedModel(typeCode, cls, state?.callsign ?? null, (model, modelEntry, anchors) => {
        // Swap in the glTF model if this entry is still alive.
        if (this.entries.get(hex) !== entry) {
          disposeDetailedModel(model)
          return
        }
        this.group.remove(entry.object)
        disposeDetailedModel(entry.object)
        entry.object = model
        entry.isGltf = true
        if (modelEntry.fit != null) {
          const [length, span] = typeDimensions(typeCode, cls)
          entry.fitScale = { span: span / modelEntry.fit[1], length: length / modelEntry.fit[0] }
        }
        // Nav lights follow this model's shape (scaled like the model).
        const { span, length } = entry.fitScale
        const scaled = (v: Vector3): Vector3 => v.clone().multiply(new Vector3(span, length, length))
        // The pose puts the fuselage axis the class placeholder's gear
        // height above the ground; shift the model so its own lowest point
        // (its wheels) sits exactly there instead of floating or sinking.
        const aircraft = flightConnection.registry.byHex.get(hex)
        const clearance = AIRFRAMES[cls].groundClearance * (aircraft?.scale.length ?? 1)
        entry.lift = -clearance - anchors.lowest * length
        const lifted = (v: Vector3): Vector3 => scaled(v).setY(scaled(v).y + entry.lift)
        modelLightAnchors.set(hex, {
          wingtip: lifted(anchors.wingtip),
          tail: lifted(anchors.tail),
          top: lifted(anchors.top),
          bottom: lifted(anchors.bottom),
          lowest: -clearance
        })
        this.group.add(model)
      })
    }
    this.entries.set(hex, entry)
    this.group.add(entry.object)
  }

  private destroy(hex: string, entry: DetailedEntry): void {
    modelLightAnchors.delete(hex)
    this.group.remove(entry.object)
    disposeDetailedModel(entry.object)
    this.entries.delete(hex)
  }

  update(sunDirection: Vector3 | null): void {
    const wanted = this.wanted()
    for (const [hex, entry] of this.entries) {
      if (!wanted.has(hex)) this.destroy(hex, entry)
    }
    for (const hex of wanted) {
      if (!this.entries.has(hex)) this.create(hex)
    }

    detailedHexes.clear()
    if (sunDirection != null) sun.copy(sunDirection)
    const anchorLength = lightAnchor.length()
    const anchorSky = skyBrightness(anchorLength > 0 ? sun.dot(lightAnchor) / anchorLength : 1)
    const selectedHex = selectionStore.get().selectedHex

    for (const [hex, entry] of this.entries) {
      const pose = flightConnection.registry.byHex.get(hex)?.pose
      if (pose == null || pose.opacity === 0) {
        entry.object.visible = false
        continue
      }
      detailedHexes.add(hex)
      const object = entry.object
      object.visible = true
      // Gear down on the ground and below ~1,500 ft above the terrain.
      const aircraft = flightConnection.registry.byHex.get(hex)
      const gear = object.getObjectByName('gear')
      if (gear != null && aircraft != null) {
        const agl = aircraft.groundHeight == null ? Infinity : pose.height - aircraft.groundHeight
        gear.visible = aircraft.attitude.ground > 0.05 || agl < 460
      }
      object.position.copy(pose.position).addScaledVector(pose.up, entry.lift)
      basis.makeBasis(pose.left, pose.up, pose.forward)
      object.quaternion.setFromRotationMatrix(basis)
      if (entry.isGltf) {
        object.scale.set(entry.fitScale.span, entry.fitScale.length, entry.fitScale.length)
      } else if (aircraft != null) {
        object.scale.set(aircraft.scale.span, aircraft.scale.length, aircraft.scale.length)
      }
      object.updateMatrixWorld()

      aircraftShading(
        sun.x,
        sun.y,
        sun.z,
        pose.position.x,
        pose.position.y,
        pose.position.z,
        pose.height,
        0,
        anchorSky,
        hex === selectedHex && cameraModeStore.get().mode === 'globe',
        shading
      )
      object.traverse(child => {
        if (child instanceof Mesh) {
          const materials: unknown[] = Array.isArray(child.material) ? child.material : [child.material]
          for (const material of materials) {
            shadingUniform(material)?.value.set(shading.x, shading.y, shading.z)
          }
        }
      })
    }
  }

  dispose(): void {
    for (const [hex, entry] of this.entries) this.destroy(hex, entry)
    detailedHexes.clear()
  }
}

export const DetailedAircraft: FC = () => {
  const { transientStates } = useContext(AtmosphereContext)
  const controller = useMemo(() => new DetailedAircraftController(), [])
  useEffect(
    () => () => {
      controller.dispose()
    },
    [controller]
  )
  useFrame(() => {
    controller.update(transientStates?.sunDirection ?? null)
  }, FRAME_PRIORITY.detailedModels)
  return <primitive object={controller.group} dispose={null} />
}
