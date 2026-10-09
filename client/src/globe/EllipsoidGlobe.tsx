import { Ellipsoid } from '@takram/three-geospatial'
import { EllipsoidMesh } from '@takram/three-geospatial/r3f'
import { useLayoutEffect, useMemo, useState, type FC } from 'react'
import { CanvasTexture, SRGBColorSpace, type Mesh, type Object3D } from 'three'

/** Equirectangular graticule (10° grid) so orientation is readable. */
function createGraticuleTexture(): CanvasTexture {
  const width = 4096
  const height = 2048
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#20384a'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = 'rgba(190, 210, 225, 0.35)'
  ctx.lineWidth = 2
  for (let lon = 0; lon <= 360; lon += 10) {
    const x = (lon / 360) * width
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let lat = 0; lat <= 180; lat += 10) {
    const y = (lat / 180) * height
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

export interface EllipsoidGlobeProps {
  onGround?: (ground: Object3D | null) => void
}

/**
 * Stand-in for Google tiles when VITE_DISABLE_TILES=1: a plain WGS84
 * ellipsoid with an unlit (albedo) material, so the atmosphere's post-process
 * lighting still works and no Google requests are made.
 */
export const EllipsoidGlobe: FC<EllipsoidGlobeProps> = ({ onGround }) => {
  const texture = useMemo(() => createGraticuleTexture(), [])
  const [mesh, setMesh] = useState<Mesh | null>(null)

  useLayoutEffect(() => {
    if (mesh == null) return
    onGround?.(mesh)
    return () => {
      onGround?.(null)
    }
  }, [mesh, onGround])

  useLayoutEffect(
    () => () => {
      texture.dispose()
    },
    [texture]
  )

  return (
    <EllipsoidMesh ref={setMesh} args={[Ellipsoid.WGS84.radii, 720, 360]}>
      <meshBasicMaterial map={texture} />
    </EllipsoidMesh>
  )
}
