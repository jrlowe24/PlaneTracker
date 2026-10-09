import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useMemo, type FC } from 'react'
import type { Object3D } from 'three'

import { getGoogleTiles } from './googleTiles'
import type { TileNormalsPlugin } from './TileNormalsPlugin'

export interface GoogleTilesGlobeProps {
  apiKey: string
  /** Receives the object that camera controls should raycast against. */
  onGround?: (ground: Object3D | null) => void
}

/**
 * Attaches the page-wide Google 3D Tiles instance to this canvas. Mounting and
 * unmounting never creates or disposes the tileset (see googleTiles.ts).
 */
export const GoogleTilesGlobe: FC<GoogleTilesGlobeProps> = ({
  apiKey,
  onGround
}) => {
  const tiles = useMemo(() => getGoogleTiles({ apiKey }), [apiKey])
  const camera = useThree(({ camera }) => camera)
  const gl = useThree(({ gl }) => gl)

  useLayoutEffect(() => {
    const normals = tiles.getPluginByName('TILE_NORMALS_PLUGIN') as
      | TileNormalsPlugin
      | undefined
    if (normals != null) {
      normals.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy())
    }
  }, [tiles, gl])

  useLayoutEffect(() => {
    tiles.setCamera(camera)
    return () => {
      tiles.deleteCamera(camera)
    }
  }, [tiles, camera])

  useLayoutEffect(() => {
    onGround?.(tiles.group)
    return () => {
      onGround?.(null)
    }
  }, [tiles, onGround])

  // Default priority: runs after the controls (-1) moved the camera and
  // before the effect composer (1) renders.
  useFrame(() => {
    camera.updateMatrixWorld()
    tiles.setResolutionFromRenderer(camera, gl)
    tiles.update()
  })

  // dispose={null}: R3F must not dispose the shared tileset on unmount.
  return <primitive object={tiles.group} dispose={null} />
}
