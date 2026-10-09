import { Canvas } from '@react-three/fiber'
import type { FC } from 'react'

import { Scene } from './scene/Scene'
import { AircraftPanel } from './ui/AircraftPanel'
import { Attribution } from './ui/Attribution'
import { DevPanel } from './ui/DevPanel'
import { QualityMenu } from './ui/QualityMenu'
import { TileErrorBanner } from './ui/TileErrorBanner'
import { WindowFrame } from './ui/WindowFrame'

export const App: FC = () => (
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
    <AircraftPanel />
    <DevPanel />
    <QualityMenu />
    <Attribution />
  </div>
)
