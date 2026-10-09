import { useThree } from '@react-three/fiber'
import { useEffect, type FC } from 'react'

import { config } from '../config'
import { getGoogleTiles } from '../globe/googleTiles'
import { useStore } from '../state/createStore'
import { QUALITY_PRESETS, qualityStore } from '../state/quality'

/** Applies the quality preset's resolution scale and tile error target. */
export const QualityApplier: FC = () => {
  const setDpr = useThree(({ setDpr }) => setDpr)
  const level = useStore(qualityStore, s => s.level)
  const preset = QUALITY_PRESETS[level]

  useEffect(() => {
    setDpr(Math.min(window.devicePixelRatio, preset.maxDpr))
  }, [setDpr, preset.maxDpr])

  useEffect(() => {
    if (config.tilesDisabled) return
    getGoogleTiles({ apiKey: config.googleMapsApiKey }).errorTarget = preset.tileErrorTarget
  }, [preset.tileErrorTarget])

  return null
}
