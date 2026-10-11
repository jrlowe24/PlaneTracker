import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, type FC } from 'react'
import { Vector2, type Object3D } from 'three'

import { getGoogleTiles, tileResolutionScale } from './googleTiles'
import { installAirportDetail } from './airportDetail'
import { setLoadOrder, updateLoadOrderView } from './loadOrder'
import { TileLookahead, TileSurround } from './lookahead'
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
    setLoadOrder(tiles, true)
    installAirportDetail(tiles)
  }, [tiles])

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
  const lookahead = useMemo(() => new TileLookahead(tiles), [tiles])
  const surround = useMemo(() => new TileSurround(tiles), [tiles])
  useEffect(
    () => () => {
      lookahead.dispose()
      surround.dispose()
    },
    [lookahead, surround]
  )
  useFrame(() => {
    camera.updateMatrixWorld()
    const size = gl.getDrawingBufferSize(drawingBuffer)
    const k = tileResolutionScale(gl.getPixelRatio())
    tiles.setResolution(camera, Math.max(1, Math.round(size.x * k)), Math.max(1, Math.round(size.y * k)))
    lookahead.update(camera, gl)
    surround.update(camera, gl)
    updateLoadOrderView(camera)
    tiles.update()
  })

  // dispose={null}: R3F must not dispose the shared tileset on unmount.
  return <primitive object={tiles.group} dispose={null} />
}

const drawingBuffer = new Vector2()
