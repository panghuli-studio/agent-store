import { RELAY_PORT, type RelayListener, type RelayStatus, type ToolTarget } from '@as/types'

/** Enabling a provider writes this address into the agents' configs, whatever port the relay listens on. */
export const AGENT_RELAY_ADDRESS = `127.0.0.1:${RELAY_PORT}`

export type RelayState = 'stopped' | 'listening' | 'failed' | 'unreported'

/** The listeners that could not bind; the daemon keeps retrying them. */
export function failedListeners(status: RelayStatus | null): RelayListener[] {
  return status?.running ? (status.listeners ?? []).filter((l) => !l.listening) : []
}

export function relayState(status: RelayStatus | null): RelayState {
  if (!status?.running) return 'stopped'
  if (!status.listeners) return 'unreported'
  return status.listeners.some((l) => l.listening) ? 'listening' : 'failed'
}

export function routedTargets(status: RelayStatus | null): ToolTarget[] {
  return (Object.entries(status?.routedAgents ?? {}) as [ToolTarget, boolean][]).filter(([, on]) => on).map(([target]) => target)
}
