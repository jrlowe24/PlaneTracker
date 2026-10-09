import type { FC } from 'react'

import { useStore } from '../state/createStore'
import { qualityStore, setQualityChoice, type QualityLevel } from '../state/quality'

const LABELS: Record<QualityLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** Quality preset picker (auto = picked for this device). */
export const QualityMenu: FC = () => {
  const choice = useStore(qualityStore, s => s.choice)
  const detected = useStore(qualityStore, s => s.detected)
  return (
    <label className='quality-menu'>
      <span className='muted'>Quality</span>
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
