import { useEffect, useState, type FC } from 'react'

/**
 * If the browser drops the WebGL context (out of GPU memory, a backgrounded
 * phone tab), say so and offer a reload instead of leaving a black screen.
 */
export const ContextLost: FC = () => {
  const [lost, setLost] = useState(false)
  useEffect(() => {
    const onLost = (event: Event): void => {
      event.preventDefault()
      setLost(true)
    }
    // The canvas may mount after this component; listen on the document.
    document.addEventListener('webglcontextlost', onLost, true)
    return () => {
      document.removeEventListener('webglcontextlost', onLost, true)
    }
  }, [])
  if (!lost) return null
  return (
    <div className='welcome-backdrop'>
      <div className='welcome' role='alertdialog' aria-labelledby='context-lost-title'>
        <h1 id='context-lost-title'>Graphics reset</h1>
        <p className='welcome-lede'>
          Your device ran short of graphics memory and the browser reset the 3D view.
        </p>
        <button
          type='button'
          className='welcome-start'
          onClick={() => {
            window.location.reload()
          }}
        >
          Reload
        </button>
      </div>
    </div>
  )
}
