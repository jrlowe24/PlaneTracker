/**
 * Three.js layer for objects lit by real light sources (SunLight/SkyLight)
 * instead of the post-process lighting; see LightingMask in PostEffects.
 */
export const AIRCRAFT_LAYER = 10

/**
 * Layer for the selective bloom's selection (nav lights only). Must differ
 * from AIRCRAFT_LAYER, or every aircraft would glow.
 */
export const GLOW_LAYER = 11
