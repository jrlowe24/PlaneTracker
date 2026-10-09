import type { FC } from 'react'

import { useStore } from '../state/createStore'
import { qualityStore, setQualityChoice, type QualityLevel } from '../state/quality'
import { resolutionStore } from '../state/resolution'

const LABELS: Record<QualityLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** Quality preset picker (auto = picked for this device). */
export const QualityMenu: FC = () => {
  const choice = useStore(qualityStore, s => s.choice)
  const detected = useStore(qualityStore, s => s.detected)
  // Adaptive quality: show when it has traded sharpness for frame rate.
  const scale = useStore(resolutionStore, s => s.scale)
  const tileFactor = useStore(resolutionStore, s => s.tileFactor)
  const adapted = scale < 0.999 || tileFactor > 1.001
  return (
    <label className='quality-menu'>
      <span className='muted'>Quality</span>
      {adapted && (
        <span
          className='muted'
          title='Lowered automatically to keep the frame rate smooth; recovers when there is headroom'
        >
          {Math.round(scale * 100)}%{tileFactor > 1.001 ? ' · coarser terrain' : ''}
        </span>
      )}
      <select
        value={choice}
        onChange={e => {
          setQualityChoice(e.target.value as QualityLevel | 'auto')
        }}
      >
        <option value='auto'>Auto ({LABELS[detected]})</option>
        <option value='low'>Low</option>
        <option value='medium'>Medium</option>
        <option value='high'>High</option>
      </select>
    </label>
  )
}
