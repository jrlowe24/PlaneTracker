import type { TilesRenderer } from '3d-tiles-renderer'
import { Mesh, type Material, type Object3D } from 'three'

import { patchWaterMaskMaterial } from '../scene/waterMaskMaterial'

/** Removes the photogrammetry triangles that the flat water mesh replaces. */
export class TileWaterMaskPlugin {
  readonly name = 'TILE_WATER_MASK_PLUGIN'
  // Tile normals and compression operate on geometry first. TilesFadePlugin
  // then wraps this material callback without replacing it.
  readonly priority = 0

  init(tiles: TilesRenderer): void {
    // Also patch models that survived Vite Fast Refresh in the global
    // TilesRenderer singleton.
    this.processTileModel(tiles.group)
  }

  processTileModel(scene: Object3D): void {
    scene.traverse(object => {
      if (!(object instanceof Mesh)) return
      const materials: Material[] = Array.isArray(object.material)
        ? object.material
        : [object.material]
      for (const material of materials) patchWaterMaskMaterial(material, 'cutout')
    })
  }
}

export function installTileWaterMask(tiles: TilesRenderer): void {
  if (tiles.getPluginByName('TILE_WATER_MASK_PLUGIN') != null) return
  tiles.registerPlugin(new TileWaterMaskPlugin())
}
