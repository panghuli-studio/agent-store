import { RELAY_PORT, type InstalledItem } from '@as/types'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { atomicWriteSecretFile } from '../config/safe-file'

export const LOCAL_RELAY_SLUG = 'local'
export const LOCAL_RELAY_BASE_URL = `http://127.0.0.1:${RELAY_PORT}`

// Written as the key of `local` by the desktop client before #207.
const PLACEHOLDER_KEY = 'built-in'

/** The built-in relay and its copies: they describe the relay itself, never an upstream. */
export function isLocalRelayEntry(entry: Pick<InstalledItem, 'slug' | 'parentSlug'>): boolean {
  return (entry.parentSlug ?? entry.slug) === LOCAL_RELAY_SLUG
}

export function normalizeLocalRelayConfig(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config }
  if (next['apiKey'] === PLACEHOLDER_KEY) delete next['apiKey']
  if ('baseUrl' in next && next['baseUrl'] !== LOCAL_RELAY_BASE_URL) next['baseUrl'] = LOCAL_RELAY_BASE_URL
  return next
}

export async function migrateLocalRelayConfig(itemDir: string): Promise<Record<string, unknown> | undefined> {
  const path = join(itemDir, 'config.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return undefined
  }
  let config: Record<string, unknown>
  try {
    config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
  const next = normalizeLocalRelayConfig(config)
  if (JSON.stringify(next) !== JSON.stringify(config)) await atomicWriteSecretFile(path, JSON.stringify(next, null, 2))
  return next
}
