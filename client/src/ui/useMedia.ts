import { useSyncExternalStore } from 'react'

/** Phone layout: one bottom sheet, bottom-sheet menus, big touch targets. */
export const PHONE_QUERY = '(max-width: 640px)'

function subscribe(query: string) {
  return (listener: () => void): (() => void) => {
    const list = window.matchMedia(query)
    list.addEventListener('change', listener)
    return () => {
      list.removeEventListener('change', listener)
    }
  }
}

const subscriptions = new Map<string, (listener: () => void) => () => void>()

export function useMediaQuery(query: string): boolean {
  let subscription = subscriptions.get(query)
  if (subscription == null) {
    subscription = subscribe(query)
    subscriptions.set(query, subscription)
  }
  return useSyncExternalStore(subscription, () => window.matchMedia(query).matches)
}

export const useIsPhone = (): boolean => useMediaQuery(PHONE_QUERY)
