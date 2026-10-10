import { useRef, useState, type PointerEvent } from 'react'

export interface SheetDragEnd {
  /** Total downward movement, px (negative = up). */
  dy: number
  /** Downward speed at release, px/ms. */
  velocity: number
}

/**
 * Vertical drag on a sheet's grab area (handle and header), the way native
 * bottom sheets move: `offset` follows the finger while dragging; a short
 * press without movement is a tap.
 */
export function useSheetDrag(onEnd: (end: SheetDragEnd) => void, onTap?: () => void) {
  const [offset, setOffset] = useState<number | null>(null)
  const start = useRef<{ y: number; lastY: number; lastT: number; velocity: number; id: number } | null>(null)

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      // Inputs and buttons inside the grab area keep their own behavior.
      if ((event.target as HTMLElement).closest('input, button:not(.sheet-grab-button)') != null) return
      start.current = { y: event.clientY, lastY: event.clientY, lastT: event.timeStamp, velocity: 0, id: event.pointerId }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const s = start.current
      if (s == null || s.id !== event.pointerId) return
      const dt = Math.max(1, event.timeStamp - s.lastT)
      s.velocity = 0.7 * ((event.clientY - s.lastY) / dt) + 0.3 * s.velocity
      s.lastY = event.clientY
      s.lastT = event.timeStamp
      const dy = event.clientY - s.y
      if (offset != null || Math.abs(dy) > 6) setOffset(dy)
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const s = start.current
      if (s == null || s.id !== event.pointerId) return
      start.current = null
      const dy = event.clientY - s.y
      setOffset(null)
      if (Math.abs(dy) <= 6 && offset == null) onTap?.()
      else onEnd({ dy, velocity: event.timeStamp - s.lastT > 80 ? 0 : s.velocity })
    },
    onPointerCancel: () => {
      start.current = null
      setOffset(null)
    }
  }
  return { offset, handlers }
}
