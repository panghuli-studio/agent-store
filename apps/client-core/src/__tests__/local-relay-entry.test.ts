// The built-in `local` relay entry (#207): enabled without a key, saved without the placeholder, migrated on read.
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { RELAY_PORT, type ProviderItem } from '@as/types'
import { EngineImpl } from '../engine'
import { ItemCatalog } from './helpers/item-catalog'

process.env['AS_CLAUDE_BIN'] = ''
process.env['AS_CODEX_BIN'] = ''

const publisher = { id: 'p1', slug: 'pub', name: 'Pub', avatarUrl: '', tier: 'official' as const }
const base = {
  description: 'desc', version: '1.0.0', publisher,
  compatibleWith: ['claude' as const, 'codex' as const],
  tags: [], downloads: 0, status: 'published' as const,
  createdAt: '2026-06-18T00:00:00Z', updatedAt: '2026-06-18T00:00:00Z',
  installHook: { steps: [] },
}
const localItem: ProviderItem = { ...base, id: 'local', name: 'local', slug: 'local', category: 'provider', configSchema: {}, supportedModels: [] }
const otherItem: ProviderItem = {
  ...base, id: 'other', name: 'Other', slug: 'other', category: 'provider',
  configSchema: { type: 'object', properties: { apiKey: { type: 'string' } } }, supportedModels: [],
}

const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`
const LEGACY = { name: '默认', apiKey: 'built-in', baseUrl: 'http://127.0.0.1:18100', level: 1 }

let aasHome: string
let claudeDir: string
let codexDir: string
let engine: EngineImpl

beforeEach(async () => {
  aasHome = await mkdtemp('/tmp/as-local-entry-home-')
  claudeDir = await mkdtemp('/tmp/as-local-entry-claude-')
  codexDir = await mkdtemp('/tmp/as-local-entry-codex-')
  engine = new EngineImpl(
    { aasHome, claudeConfigDir: claudeDir, codexConfigDir: codexDir },
    'http://localhost:3000',
    {
      startRelay: async () => { await writeFile(join(aasHome, 'relay.pid'), String(process.pid)) },
      catalog: new ItemCatalog(() => [localItem, otherItem]),
    }
  )
})

afterEach(async () => {
  for (const d of [aasHome, claudeDir, codexDir]) await rm(d, { recursive: true, force: true })
})

const configOf = async (slug: string) => JSON.parse(await readFile(join(aasHome, 'providers', slug, 'config.json'), 'utf-8'))

test('local is enabled without any API key and points the agent at the relay port', async () => {
  await engine.install('local')
  expect((await engine.getTargetStatus('local')).map(s => s.blocker)).toEqual([undefined, undefined])

  await engine.enable('local', 'claude')

  const settings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf-8'))
  expect(settings.env.ANTHROPIC_BASE_URL).toBe(RELAY_URL)
  expect((await engine.info('local')).enabledFor.claude).toBe(true)
})

test('saving local drops the placeholder key and replaces a stale address with the relay port', async () => {
  await engine.install('local')

  await engine.setConfig('local', LEGACY)

  expect(await configOf('local')).toEqual({ name: '默认', baseUrl: RELAY_URL, level: 1 })
})

test('a local entry saved by an older client is migrated when it is read', async () => {
  await engine.install('local')
  await writeFile(join(aasHome, 'providers', 'local', 'config.json'), JSON.stringify(LEGACY))

  const detail = await engine.info('local')

  expect(detail.currentConfig).toEqual({ name: '默认', baseUrl: RELAY_URL, level: 1 })
  expect(await configOf('local')).toEqual({ name: '默认', baseUrl: RELAY_URL, level: 1 })
  expect((await engine.getConfigSchema('local')).current).toEqual({ name: '默认', baseUrl: RELAY_URL, level: 1 })
})

test('other providers are saved as given, even with the same values', async () => {
  await engine.install('other')

  await engine.setConfig('other', LEGACY)

  expect(await configOf('other')).toEqual(LEGACY)
})

test('duplicateProvider names the copy with the name the client passes', async () => {
  await engine.install('other')
  await engine.setConfig('other', { name: 'Work', apiKey: 'k', baseUrl: 'https://x.example' })

  const { newSlug } = await engine.duplicateProvider('other', 'Work copy')

  expect(newSlug).toBe('other-copy')
  const detail = await engine.info(newSlug)
  expect(detail.name).toBe('Work copy')
  expect(detail.currentConfig).toEqual({ name: 'Work copy', apiKey: '', baseUrl: 'https://x.example' })
})
