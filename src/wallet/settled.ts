import { useSyncExternalStore } from 'react'
import { watchConnection } from 'wagmi/actions'
import { wagmiConfig } from './config'

const RECONNECT_GRACE_MS = 5000

let settled = false

function subscribe(notify: () => void) {
  if (settled) return () => undefined
  const settle = () => {
    settled = true
    release()
    notify()
  }
  const stop = watchConnection(wagmiConfig, {
    onChange(connection, previous) {
      const tried = previous.status === 'connecting' || previous.status === 'reconnecting'
      if (connection.status === 'connected' || (connection.status === 'disconnected' && tried)) settle()
    },
  })
  const timer = setTimeout(settle, RECONNECT_GRACE_MS)
  const release = () => {
    stop()
    clearTimeout(timer)
  }
  return release
}

export const useWalletSettled = () =>
  useSyncExternalStore(
    subscribe,
    () => settled || wagmiConfig.state.status === 'connected',
    () => false,
  )
