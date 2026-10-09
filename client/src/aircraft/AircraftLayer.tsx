import { useFrame, useThree } from '@react-three/fiber'
import { AtmosphereContext } from '@takram/three-atmosphere/r3f'
import { useContext, useEffect, useMemo, type FC } from 'react'
import type { PerspectiveCamera } from 'three'

import { AircraftInstances } from './aircraftInstances'
import { GroundShadows } from './groundShadows'
import { NavLights } from './navLights'
import { FRAME_PRIORITY } from './framePriority'

export const AircraftLayer: FC = () => {
  const camera = useThree(({ camera }) => camera as PerspectiveCamera)
  const size = useThree(({ size }) => size)
  const { transientStates } = useContext(AtmosphereContext)
  const instances = useMemo(() => new AircraftInstances(), [])
  const navLights = useMemo(() => new NavLights(), [])
  const shadows = useMemo(() => new GroundShadows(), [])
  useEffect(
    () => () => {
      instances.dispose()
      navLights.dispose()
      shadows.dispose()
    },
    [instances, navLights, shadows]
  )

  useFrame((_, delta) => {
    instances.updatePoses(Math.min(delta, 0.25))
  }, FRAME_PRIORITY.aircraftPoses)

  useFrame(({ clock, gl }) => {
    instances.updateInstances(camera, size.height, transientStates?.sunDirection ?? null)
    navLights.update(camera, size.height, clock.elapsedTime, gl.toneMappingExposure)
    shadows.update(camera, transientStates?.sunDirection ?? null)
  }, FRAME_PRIORITY.aircraftInstances)

  return (
    <>
      <primitive object={instances.group} dispose={null} />
      <primitive object={navLights.mesh} dispose={null} />
      <primitive object={shadows.mesh} dispose={null} />
    </>
  )
}
