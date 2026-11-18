import { test, expect } from 'bun:test'
import type { BackupStatus, BackupSyncResult, Engine } from '@as/types'
import { runBackup, type BackupIo } from '../backup'
import { runRpc } from '../rpc'

type TestIo = BackupIo & { lines: string[]; asked: number }

function io(secret = 'tok-123'): TestIo {
  const o: TestIo = { lines: [], asked: 0, out: s => { o.lines.push(s) }, readSecret: async () => { o.asked++; return secret } }
  return o
}

const engine = (overrides: Partial<Engine>) => overrides as unknown as Engine

const status: BackupStatus = {
  connected: true, remote: 'git@example.com:me/backup.git', branch: 'main', device: 'laptop', connectedAt: '',
  hasCredentials: false, localChanges: [{ key: 'skill/notes', category: 'skill', slug: 'notes' }], remoteAhead: null,
  conflicts: [{ key: 'mcp/db', category: 'mcp', slug: 'db', reason: 'both-changed', parts: ['content'], remoteDevice: 'desktop', detectedAt: '' }],
  missingSecrets: [{ key: 'provider/p', category: 'provider', slug: 'p', targets: ['claude'], reason: 'no-key', message: '' }],
  failed: [], localOnly: [], notRestorable: [], excludedFiles: [], secretFindings: [],
}

test('connect reads the token from stdin and refuses it on the command line', async () => {
  let got: unknown
  const e = engine({ connectBackup: async (o: unknown) => { got = o; return { status, remoteItems: 3 } } })
  const o = io()
  expect(await runBackup(e, ['connect', 'https://example.com/r.git', '--device', 'laptop', '--token-stdin'], o)).toBe(0)
  expect(got).toEqual({ remote: 'https://example.com/r.git', device: 'laptop', token: 'tok-123' })
  expect(o.asked).toBe(1)
  expect(o.lines.join('\n')).toContain('aas backup pull')
  expect(await runBackup(e, ['connect', 'https://example.com/r.git', '--token', 'tok'], io())).toBe(2)
  const empty = io('')
  expect(await runBackup(e, ['connect', 'https://example.com/r.git', '--token-stdin'], empty)).toBe(1)
})

test('status lists local changes, conflicts with the remote device, and missing keys with what to run', async () => {
  const o = io()
  expect(await runBackup(engine({ getBackupStatus: async () => status }), ['status'], o)).toBe(0)
  const text = o.lines.join('\n')
  expect(text).toContain('Local changes: skill/notes')
  expect(text).toContain('mcp/db')
  expect(text).toContain('desktop')
  expect(text).toContain('aas config p')
})

test('now reports what moved, and exits 1 when a remote change could not be applied', async () => {
  const result: BackupSyncResult = {
    pushed: 'abcdef1234567890', uploaded: [{ key: 'skill/notes', category: 'skill', slug: 'notes' }],
    applied: [{ key: 'mcp/db', category: 'mcp', slug: 'db', actions: ['updated', 'enabled'] }], snapshot: '20261114T000000Z',
    conflicts: [], missingSecrets: [], failed: [], localOnly: [], notRestorable: [], excludedFiles: [],
  }
  const o = io()
  expect(await runBackup(engine({ backupNow: async () => result }), ['now'], o)).toBe(0)
  expect(o.lines.join('\n')).toContain('mcp/db: updated, enabled')
  const failing = { ...result, failed: [{ key: 'mcp/db', category: 'mcp' as const, slug: 'db', message: 'boom', at: '' }] }
  expect(await runBackup(engine({ pullBackup: async () => failing }), ['pull'], io())).toBe(1)
})

test('resolve takes a slug and one of local, remote, both', async () => {
  let got: unknown[] = []
  const e = engine({
    resolveBackupConflict: async (...a: unknown[]) => {
      got = a
      return { item: { key: 'mcp/db', category: 'mcp', slug: 'db' }, choice: 'both', keptAs: 'db-desktop', snapshot: 's1', applied: [], missingSecrets: [] }
    },
  })
  const o = io()
  expect(await runBackup(e, ['resolve', 'db', 'both'], o)).toBe(0)
  expect(got).toEqual(['db', 'both'])
  expect(o.lines.join('\n')).toContain('db-desktop')
  expect(o.lines.join('\n')).toContain('aas backup restore s1')
  expect(await runBackup(e, ['resolve', 'db', 'mine'], io())).toBe(2)
})

test('connectBackup over RPC takes its token from the stdin line, not argv', async () => {
  let got: unknown
  const e = engine({ connectBackup: async (o: unknown) => { got = o; return { status, remoteItems: 0 } } })
  const out: string[] = []
  const line = JSON.stringify([{ remote: 'https://h/r.git', token: 'secret-tok' }])
  expect(await runRpc(e, ['connectBackup', '-'], s => out.push(s), async () => line)).toBe(0)
  expect(got).toEqual({ remote: 'https://h/r.git', token: 'secret-tok' })
  expect(JSON.parse(out[0]).ok).toBe(true)
})

const code = { deviceCode: 'dc-1', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }
const existing = { fullName: 'me/agent-store-backup', private: true, url: 'https://github.com/me/agent-store-backup' }

function gitHubEngine(polls: Array<Awaited<ReturnType<Engine['pollGitHubBackupSignIn']>>>, calls: unknown[]) {
  return engine({
    startGitHubBackupSignIn: async () => code,
    pollGitHubBackupSignIn: async (dc: string) => { calls.push(['poll', dc]); return polls.shift()! },
    connectGitHubBackup: async (o: unknown) => { calls.push(['connect', o]); return { status: { ...status, remote: 'https://github.com/me/agent-store-backup.git' }, remoteItems: 2 } },
    cancelGitHubBackupSignIn: async () => { calls.push(['cancel']) },
  })
}

test('connect --github shows the code and address, waits for the approval and creates the repository', async () => {
  const calls: unknown[] = []
  const waits: number[] = []
  const e = gitHubEngine([{ status: 'pending' }, { status: 'slow_down', interval: 10 }, { status: 'approved', login: 'me', existing: null, create: 'me/agent-store-backup' }], calls)
  const o: TestIo = { ...io(), wait: async ms => { waits.push(ms); return true } }
  expect(await runBackup(e, ['connect', '--github', '--device', 'laptop'], o)).toBe(0)
  const text = o.lines.join('\n')
  expect(text).toContain('https://github.com/login/device')
  expect(text).toContain('WDJB-MJHT')
  expect(text).toContain('"repo" scope')
  expect(text).toContain('Creating the private repository me/agent-store-backup')
  expect(waits).toEqual([5000, 5000, 10000])
  expect(calls.at(-1)).toEqual(['connect', { repo: 'new', device: 'laptop' }])
  expect(await runBackup(e, ['connect', '--github', 'https://h/r.git'], io())).toBe(2)
  expect(await runBackup(e, ['connect', 'https://h/r.git', '--new'], io())).toBe(2)
})

test('connect --github offers the backup an earlier device made; --new and a no create a new one', async () => {
  const approved = { status: 'approved' as const, login: 'me', existing, create: 'me/agent-store-backup-2' }
  for (const [args, answer, repo] of [[[], true, 'existing'], [[], false, 'new'], [['--new'], true, 'new'], [[], null, 'existing']] as const) {
    const calls: unknown[] = []
    const o: TestIo = { ...io(), wait: async () => true, confirm: async () => answer }
    expect(await runBackup(gitHubEngine([approved], calls), ['connect', '--github', ...args], o)).toBe(0)
    expect(calls.at(-1)).toEqual(['connect', { repo }])
  }
})

test('connect --github ends denied, expired and cancelled sign-ins with how to try again', async () => {
  for (const [poll, words] of [[{ status: 'denied' }, 'denied'], [{ status: 'expired' }, 'expired']] as const) {
    const calls: unknown[] = []
    const o: TestIo = { ...io(), wait: async () => true }
    expect(await runBackup(gitHubEngine([poll], calls), ['connect', '--github'], o)).toBe(1)
    expect(o.lines.join('\n')).toContain(words)
    expect(o.lines.join('\n')).toContain('aas backup connect --github')
    expect(calls.some(c => (c as string[])[0] === 'connect')).toBe(false)
  }
  const calls: unknown[] = []
  const o: TestIo = { ...io(), wait: async () => false }
  expect(await runBackup(gitHubEngine([], calls), ['connect', '--github'], o)).toBe(1)
  expect(o.lines.join('\n')).toContain('Cancelled')
  expect(calls).toEqual([])
})

test('the GitHub methods are reachable over RPC and never return the token', async () => {
  const calls: unknown[] = []
  const e = gitHubEngine([{ status: 'approved', login: 'me', existing: null, create: 'me/agent-store-backup' }], calls)
  const out: string[] = []
  expect(await runRpc(e, ['startGitHubBackupSignIn', '-'], s => out.push(s), async () => '[]')).toBe(0)
  expect(await runRpc(e, ['pollGitHubBackupSignIn', '-'], s => out.push(s), async () => '["dc-1"]')).toBe(0)
  expect(await runRpc(e, ['connectGitHubBackup', '-'], s => out.push(s), async () => '[{"repo":"new"}]')).toBe(0)
  expect(await runRpc(e, ['cancelGitHubBackupSignIn', '-'], s => out.push(s), async () => '[]')).toBe(0)
  expect(out.map(l => JSON.parse(l).ok)).toEqual([true, true, true, true])
  expect(calls).toEqual([['poll', 'dc-1'], ['connect', { repo: 'new' }], ['cancel']])
})
