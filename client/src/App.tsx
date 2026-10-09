import { Canvas } from '@react-three/fiber'
import type { FC } from 'react'

import { Scene } from './scene/Scene'
import { AircraftList } from './ui/AircraftList'
import { AircraftPanel } from './ui/AircraftPanel'
import { Attribution } from './ui/Attribution'
import { ContextLost } from './ui/ContextLost'
import { DevPanel } from './ui/DevPanel'
import { QualityMenu } from './ui/QualityMenu'
import { TileErrorBanner } from './ui/TileErrorBanner'
import { TopBar } from './ui/Welcome'
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
    <div className='left-stack'>
      <AircraftList />
      <AircraftPanel />
    </div>
    <DevPanel />
    <TopBar />
    <div className='corner-quality'>
      <QualityMenu />
    </div>
    <Attribution />
    <ContextLost />
  </div>
)
