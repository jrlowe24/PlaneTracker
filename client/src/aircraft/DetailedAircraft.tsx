import { useFrame } from '@react-three/fiber'
import { AtmosphereContext } from '@takram/three-atmosphere/r3f'
import { useContext, useEffect, useMemo, type FC } from 'react'
import { Group, Matrix4, Mesh, Vector3, type Object3D } from 'three'

import { flightConnection } from '../data/flightConnection'
import { cameraModeStore } from '../state/cameraMode'
import { selectionStore } from '../state/selection'
import { shadingUniform } from './aircraftMaterial'
import { aircraftClass } from './typeClasses'
import type { AircraftClass } from './airframes'
import { detailedHexes } from './detailState'
import { FRAME_PRIORITY } from './framePriority'
import { lightAnchor } from './lightAnchor'
import { createDetailedModel, disposeDetailedModel } from './models'
import { aircraftShading, skyBrightness } from './shading'

/** Aircraft closer than this get a detailed model instead of an instance. */
const DETAIL_RADIUS = 1500
const MAX_DETAILED = 12

interface DetailedEntry {
  object: Object3D
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
      cls,
      typeCode,
      object: createDetailedModel(typeCode, cls, model => {
        // Swap in the glTF model if this entry is still alive.
        if (this.entries.get(hex) !== entry) {
          disposeDetailedModel(model)
          return
        }
        this.group.remove(entry.object)
        disposeDetailedModel(entry.object)
        entry.object = model
        this.group.add(model)
      })
    }
    this.entries.set(hex, entry)
    this.group.add(entry.object)
  }

  private destroy(hex: string, entry: DetailedEntry): void {
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
      object.position.copy(pose.position)
      basis.makeBasis(pose.left, pose.up, pose.forward)
      object.quaternion.setFromRotationMatrix(basis)
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
