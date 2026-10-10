/** Phones (touch, small screen): tighter memory and GPU budgets. */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const small = Math.min(window.screen.width, window.screen.height) < 820
  return coarse && small
}
