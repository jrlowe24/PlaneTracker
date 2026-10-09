import { Vector3 } from 'three'

/**
 * Where the SunLight color and SkyLight probe are evaluated (ECEF): above
 * the view center, or the followed aircraft. Per-aircraft shading is scaled
 * relative to this point.
 */
export const lightAnchor = new Vector3()
