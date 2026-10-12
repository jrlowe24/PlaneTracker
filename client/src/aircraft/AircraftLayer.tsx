import { useFrame, useThree } from '@react-three/fiber'
import { AtmosphereContext } from '@takram/three-atmosphere/r3f'
import { useContext, useEffect, useMemo, type FC } from 'react'
import type { PerspectiveCamera } from 'three'

import { flightConnection } from '../data/flightConnection'
import { AircraftInstances } from './aircraftInstances'
import { Contrails } from './contrails'
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
  const contrails = useMemo(() => new Contrails(), [])
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __contrails: contrails })
  }, [contrails])
  useEffect(
    () => () => {
      instances.dispose()
      navLights.dispose()
      shadows.dispose()
      contrails.dispose()
    },
    [instances, navLights, shadows, contrails]
  )

  useFrame((_, delta) => {
    instances.updatePoses(Math.min(delta, 0.25))
    contrails.record(flightConnection.registry, Math.min(delta, 0.25))
  }, FRAME_PRIORITY.aircraftPoses)

  // After the effect composer (priority 1) drew the frame: contrails, then
  // map arrows on top.
  useFrame(({ gl }) => {
    contrails.render(gl, camera)
    instances.arrows.render(gl, camera)
  }, 2)

  useFrame(({ clock, gl }) => {
    instances.updateInstances(camera, size.height, transientStates?.sunDirection ?? null)
    navLights.update(camera, size.height, clock.elapsedTime, gl.toneMappingExposure)
    shadows.update(camera, transientStates?.sunDirection ?? null)
    contrails.update(flightConnection.registry, camera, transientStates?.sunDirection ?? null)
  }, FRAME_PRIORITY.aircraftInstances)

  return (
    <>
      <primitive object={instances.group} dispose={null} />
      <primitive object={navLights.mesh} dispose={null} />
      <primitive object={shadows.mesh} dispose={null} />
    </>
  )
}
