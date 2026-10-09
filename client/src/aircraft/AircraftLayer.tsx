import { useFrame, useThree } from '@react-three/fiber'
import { AtmosphereContext } from '@takram/three-atmosphere/r3f'
import { useContext, useEffect, useMemo, type FC } from 'react'
import type { PerspectiveCamera } from 'three'

import { AircraftInstances } from './aircraftInstances'
import { NavLights } from './navLights'
import { navLightsStore } from './navLightsStore'
import { FRAME_PRIORITY } from './framePriority'

export const AircraftLayer: FC = () => {
  const camera = useThree(({ camera }) => camera as PerspectiveCamera)
  const size = useThree(({ size }) => size)
  const { transientStates } = useContext(AtmosphereContext)
  const instances = useMemo(() => new AircraftInstances(), [])
  const navLights = useMemo(() => new NavLights(), [])
  useEffect(() => {
    navLightsStore.set({ mesh: navLights.mesh })
    return () => {
      navLightsStore.set({ mesh: null })
      instances.dispose()
      navLights.dispose()
    }
  }, [instances, navLights])

  useFrame((_, delta) => {
    instances.updatePoses(Math.min(delta, 0.25))
  }, FRAME_PRIORITY.aircraftPoses)

  useFrame(({ clock, gl }) => {
    instances.updateInstances(camera, size.height, transientStates?.sunDirection ?? null)
    navLights.update(camera, size.height, clock.elapsedTime, gl.toneMappingExposure)
  }, FRAME_PRIORITY.aircraftInstances)

  return (
    <>
      <primitive object={instances.group} dispose={null} />
      <primitive object={navLights.mesh} dispose={null} />
    </>
  )
}
