import type { FC } from 'react'

import { useStore } from '../state/createStore'
import { qualityStore, setQualityElement, type QualityElements } from '../state/quality'
import { Segmented } from './Segmented'

import './qualityDetails.css'

type Key = keyof QualityElements

interface Row {
  key: Key
  label: string
  /** What it trades, in a few words. */
  hint: string
  options: Array<{ id: string; label: string }>
}

const FOUR = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Med' },
  { id: 'high', label: 'High' },
  { id: 'ultra', label: 'Ultra' }
]
const THREE = FOUR.slice(0, 3)
const ON_OFF = [
  { id: 'off', label: 'Off' },
  { id: 'on', label: 'On' }
]

const ROWS: Row[] = [
  { key: 'resolution', label: 'Resolution', hint: 'Sharpness; the biggest cost on large screens', options: FOUR },
  { key: 'terrain', label: 'Terrain detail', hint: 'Map detail in the distance; memory and loading', options: FOUR },
  {
    key: 'clouds',
    label: 'Clouds',
    hint: 'Volumetric clouds',
    options: [{ id: 'off', label: 'Off' }, ...THREE]
  },
  { key: 'cloudShadows', label: 'Cloud shadows', hint: 'Clouds shading the ground', options: ON_OFF },
  { key: 'cityLights', label: 'City lights', hint: 'Detailed night lights; High adds lit windows', options: THREE },
  {
    key: 'lightDistance',
    label: 'Light distance',
    hint: 'How far out street lights are drawn one by one; memory',
    options: [
      { id: 'near', label: 'Near' },
      { id: 'medium', label: 'Med' },
      { id: 'far', label: 'Far' }
    ]
  },
  { key: 'aircraft', label: 'Aircraft detail', hint: 'How many nearby aircraft get full models', options: THREE },
  { key: 'lensFlare', label: 'Lens flare', hint: 'Glare from the sun and bright lights', options: ON_OFF }
]

const toId = (value: QualityElements[Key]): string =>
  typeof value === 'boolean' ? (value ? 'on' : 'off') : value

/**
 * Each part of the graphics on its own. The presets set all of them;
 * changing one makes the choice Custom (remembered on this device).
 */
export const QualityDetails: FC = () => {
  const elements = useStore(qualityStore, s => s.elements)
  const custom = useStore(qualityStore, s => s.choice === 'custom')
  return (
    <details className='quality-details' open={custom || undefined}>
      <summary>Customize</summary>
      {ROWS.map(row => (
        <div className='quality-row' key={row.key}>
          <div className='quality-row-label'>
            <span>{row.label}</span>
            <span className='quality-row-hint'>{row.hint}</span>
          </div>
          <Segmented
            compact
            label={row.label}
            options={row.options}
            value={toId(elements[row.key])}
            onChange={id => {
              const value = row.options === ON_OFF ? id === 'on' : id
              setQualityElement(row.key, value as QualityElements[typeof row.key])
            }}
          />
        </div>
      ))}
    </details>
  )
}
