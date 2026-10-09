import type { Texture } from 'three'

/**
 * The clouds' own front-depth buffer (r: distance to the first cloud along
 * each ray, or the scene depth where none), at the clouds' render
 * resolution. AerialPerspective uses it to keep upsampled cloud overlay
 * off aircraft that are in front of the clouds.
 */
export const cloudDepth: { texture: Texture | null } = { texture: null }
