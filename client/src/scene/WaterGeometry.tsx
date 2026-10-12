import { PlaneGeometry, MeshBasicMaterial, Color } from 'three'
import { useEffect, useMemo, type FC } from 'react'

import { patchWaterMaskMaterial } from './waterMaskMaterial'

// Covers the largest streamed semantic-water window with room for a grazing
// camera. Dense local tessellation keeps the ellipsoid sag below a metre;
// a low-resolution whole-Earth sphere visibly facets the water surface.
const PATCH_SIZE_METERS = 320_000
const PATCH_SEGMENTS = 256

export const WaterGeometry: FC = () => {
  const geometry = useMemo(
    () =>
      new PlaneGeometry(
        PATCH_SIZE_METERS,
        PATCH_SIZE_METERS,
        PATCH_SEGMENTS,
        PATCH_SEGMENTS
      ),
    []
  )
  const material = useMemo(() => {
    // This albedo is replaced with the procedural Fresnel/wave lighting in
    // waterSurface.ts, but remains a safe fallback if that effect is absent.
    const value = new MeshBasicMaterial({
      color: new Color(0.006, 0.025, 0.035),
      depthTest: true,
      depthWrite: true
    })
    patchWaterMaskMaterial(value, 'surface')
    return value
  }, [])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material]
  )

  return (
    <mesh
      geometry={geometry}
      material={material}
      // Vertex displacement moves a local plane from the origin to ECEF;
      // its CPU-side bounding box therefore cannot be used for culling.
      frustumCulled={false}
      renderOrder={-1}
    />
  )
}
