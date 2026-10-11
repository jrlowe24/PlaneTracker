import type { Object3D } from 'three'

/**
 * Objects hidden while the normal pass renders. It draws the whole scene
 * with one override material, so a decal's own shader (a soft silhouette
 * that discards outside its shape) is lost and its full quad lands in the
 * normal buffer: the post-process sunlight then lights a flat rectangle
 * instead of the terrain under it (a dark square under aircraft at sunset).
 */
export const normalPassExclusions = new Set<Object3D>()
