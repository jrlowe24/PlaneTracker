import { useFrame, useThree } from '@react-three/fiber'
import { AtmosphereContext } from '@takram/three-atmosphere/r3f'
import { useContext, useEffect, useMemo, type FC } from 'react'
import type { PerspectiveCamera } from 'three'

import { AircraftInstances } from './aircraftInstances'
import { FRAME_PRIORITY } from './framePriority'

export const AircraftLayer: FC = () => {
  const camera = useThree(({ camera }) => camera as PerspectiveCamera)
  const size = useThree(({ size }) => size)
  const { transientStates } = useContext(AtmosphereContext)
  const instances = useMemo(() => new AircraftInstances(), [])
  useEffect(
    () => () => {
      instances.dispose()
    },
    [instances]
  )

  useFrame((_, delta) => {
    instances.updatePoses(Math.min(delta, 0.25))
  }, FRAME_PRIORITY.aircraftPoses)

  useFrame(() => {
    instances.updateInstances(camera, size.height, transientStates?.sunDirection ?? null)
  }, FRAME_PRIORITY.aircraftInstances)

  return <primitive object={instances.group} dispose={null} />
}
