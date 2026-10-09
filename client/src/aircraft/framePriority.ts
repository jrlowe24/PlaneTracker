/**
 * useFrame priorities, lowest first. Any non-zero priority disables R3F's
 * automatic render; the effect composer renders at `render`.
 *
 *   aircraftPoses   interpolate + attitude for all aircraft
 *   camera          chase/window camera follows the interpolated pose
 *   controls        GlobeControls (3d-tiles-renderer registers at -1)
 *   detailedModels  full-detail models placed from the poses
 *   (0)             tiles update, instance matrices relative to the camera
 *   render          effect composer
 */
export const FRAME_PRIORITY = {
  aircraftPoses: -3,
  camera: -2,
  controls: -1,
  detailedModels: -0.5,
  aircraftInstances: 0,
  render: 1
} as const
