import { Canvas } from '@react-three/fiber'
import type { FC } from 'react'

import { Scene } from './scene/Scene'
import { AircraftList } from './ui/AircraftList'
import { AircraftPanel } from './ui/AircraftPanel'
import { Attribution } from './ui/Attribution'
import { ContextLost } from './ui/ContextLost'
import { DevPanel } from './ui/DevPanel'
import { ModeBar } from './ui/ModeBar'
import { PhoneSheet } from './ui/PhoneSheet'
import { SettingsPanel } from './ui/SettingsPanel'
import { TileErrorBanner } from './ui/TileErrorBanner'
import { useIsPhone } from './ui/useMedia'
import { TopBar } from './ui/Welcome'
import { WindowFrame } from './ui/WindowFrame'

export const App: FC = () => {
  const phone = useIsPhone()
  return (
    <div className='app'>
      <Canvas
        // The effect composer owns depth; the default framebuffer needs none.
        gl={{ depth: false }}
        camera={{ fov: 50, near: 1, far: 1e8 }}
        dpr={[1, 2]}
      >
        <Scene />
      </Canvas>
      <WindowFrame />
      <TileErrorBanner />
      {phone ? (
        <PhoneSheet />
      ) : (
        <div className='left-stack'>
          <AircraftList />
          <AircraftPanel />
        </div>
      )}
      <DevPanel />
      <TopBar />
      <ModeBar />
      <SettingsPanel />
      <Attribution />
      <ContextLost />
    </div>
  )
}
