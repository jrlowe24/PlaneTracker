import { Canvas } from '@react-three/fiber'
import type { FC } from 'react'

import { Scene } from './scene/Scene'
import { Attribution } from './ui/Attribution'
import { DevPanel } from './ui/DevPanel'
import { TileErrorBanner } from './ui/TileErrorBanner'

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
    <TileErrorBanner />
    <DevPanel />
    <Attribution />
  </div>
)
