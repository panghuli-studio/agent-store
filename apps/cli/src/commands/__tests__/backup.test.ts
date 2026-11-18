import { test, expect } from 'bun:test'
import type { BackupDisconnectLevel, BackupDisconnectResult, BackupStatus, BackupSyncResult, Engine } from '@as/types'
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

test('pullBackup over RPC forwards the first-launch rollback option', async () => {
  let got: unknown
  const e = engine({ pullBackup: async (options) => { got = options; return { pushed: null, uploaded: [], applied: [], snapshot: 'before', conflicts: [], missingSecrets: [], failed: [], localOnly: [], notRestorable: [], excludedFiles: [] } } })
  expect(await runRpc(e, ['pullBackup', '-'], () => undefined, async () => '[{"firstRun":true}]')).toBe(0)
  expect(got).toEqual({ firstRun: true })
})

const ghStatus: BackupStatus = { ...status, remote: 'https://github.com/me/agent-store-backup.git', hasCredentials: true, github: { login: 'me', repo: 'me/agent-store-backup' } }
const removed = { level: 'device' as const, remote: ghStatus.remote, repo: 'me/agent-store-backup' }

function disconnectEngine(s: BackupStatus, calls: unknown[], polls: Array<Awaited<ReturnType<Engine['pollGitHubBackupDeleteSignIn']>>> = []) {
  return engine({
    getBackupStatus: async () => s,
    disconnectBackup: async (o?: { level?: BackupDisconnectLevel }): Promise<BackupDisconnectResult> => {
      calls.push(['disconnect', o])
      const level = o?.level ?? 'device'
      return {
        ...removed, level,
        ...(s.github ? {} : { repo: undefined }),
        ...(level !== 'device' ? { revoked: true, authorizationsUrl: 'https://github.com/settings/connections/applications/x' } : {}),
        ...(level === 'delete' ? { repoDeleted: 'deleted' as const } : {}),
      }
    },
    startGitHubBackupDeleteSignIn: async () => { calls.push(['start-delete']); return code },
    pollGitHubBackupDeleteSignIn: async () => polls.shift()!,
    cancelGitHubBackupSignIn: async () => { calls.push(['cancel']) },
  })
}

test('disconnect alone forgets this device, says the remote stays and that the GitHub authorization was not revoked', async () => {
  const calls: unknown[] = []
  const o = io()
  expect(await runBackup(disconnectEngine(ghStatus, calls), ['disconnect'], o)).toBe(0)
  expect(calls).toEqual([['disconnect', undefined]])
  const text = o.lines.join('\n')
  expect(text).toContain('Removed ~/.agent-store/backup/')
  expect(text).toContain('other devices keep syncing')
  expect(text).toContain('--revoke does that')
})

test('disconnect --revoke explains, asks, and reports what other devices keep', async () => {
  const calls: unknown[] = []
  const o: TestIo = { ...io(), confirm: async () => true }
  expect(await runBackup(disconnectEngine(ghStatus, calls), ['disconnect', '--revoke'], o)).toBe(0)
  expect(calls).toEqual([['disconnect', { level: 'revoke' }]])
  const text = o.lines.join('\n')
  expect(text).toContain("revokes this device's GitHub token")
  expect(text).toContain("Revoked this device's GitHub token")
  expect(text).toContain('with their own sign-in')
  expect(text).toContain('https://github.com/settings/connections/applications/x')

  const no: unknown[] = []
  expect(await runBackup(disconnectEngine(ghStatus, no), ['disconnect', '--revoke'], { ...io(), confirm: async () => false })).toBe(1)
  expect(await runBackup(disconnectEngine(ghStatus, no), ['disconnect', '--revoke'], { ...io(), confirm: async () => null })).toBe(1)
  expect(no).toEqual([])
  expect(await runBackup(disconnectEngine(ghStatus, no), ['disconnect', '--revoke', '--yes'], io())).toBe(0)
  expect(no).toEqual([['disconnect', { level: 'revoke' }]])
})

test('disconnect --delete-remote asks for the name before the deletion sign-in, then deletes', async () => {
  const calls: unknown[] = []
  const o: TestIo = { ...io(), wait: async () => true, ask: async () => 'me/agent-store-backup' }
  const e = disconnectEngine(ghStatus, calls, [{ status: 'pending' }, { status: 'approved', login: 'me', repo: 'me/agent-store-backup' }])
  expect(await runBackup(e, ['disconnect', '--delete-remote'], o)).toBe(0)
  expect(calls).toEqual([['start-delete'], ['disconnect', { level: 'delete', confirm: 'me/agent-store-backup' }]])
  const text = o.lines.join('\n')
  expect(text).toContain('cannot be undone')
  expect(text).toContain('"delete_repo" scope')
  expect(text).toContain('Deleted the repository me/agent-store-backup on GitHub')
  expect(text).toContain('their sync now fails')

  const wrong: unknown[] = []
  expect(await runBackup(disconnectEngine(ghStatus, wrong), ['disconnect', '--delete-remote'], { ...io(), ask: async () => 'me/other' })).toBe(1)
  expect(await runBackup(disconnectEngine(ghStatus, wrong), ['disconnect', '--delete-remote'], { ...io(), ask: async () => null })).toBe(1)
  expect(wrong).toEqual([])

  const denied: unknown[] = []
  const d: TestIo = { ...io(), wait: async () => true }
  expect(await runBackup(disconnectEngine(ghStatus, denied, [{ status: 'denied' }]), ['disconnect', '--delete-remote', '--confirm', 'me/agent-store-backup'], d)).toBe(1)
  expect(d.lines.join('\n')).toContain('Nothing was changed')
  expect(denied).toEqual([['start-delete']])
})

test('a failed deletion drops the deletion sign-in and prints which step failed', async () => {
  const calls: unknown[] = []
  const e = engine({
    getBackupStatus: async () => ghStatus,
    startGitHubBackupDeleteSignIn: async () => code,
    pollGitHubBackupDeleteSignIn: async () => ({ status: 'approved', login: 'me', repo: 'me/agent-store-backup' }),
    disconnectBackup: async () => { throw Object.assign(new Error('Deleting the repository me/agent-store-backup on GitHub failed: GitHub answered 403'), { reason: 'delete-failed' }) },
    cancelGitHubBackupSignIn: async () => { calls.push(['cancel']) },
  })
  const o: TestIo = { ...io(), wait: async () => true }
  expect(await runBackup(e, ['disconnect', '--delete-remote', '--confirm', 'me/agent-store-backup'], o)).toBe(1)
  expect(o.lines.join('\n')).toContain('Deleting the repository me/agent-store-backup on GitHub failed')
  expect(calls).toEqual([['cancel']])
})

test('revoking and deleting are refused for a Git URL connection, with the reason', async () => {
  for (const flag of ['--revoke', '--delete-remote']) {
    const calls: unknown[] = []
    const o: TestIo = { ...io(), confirm: async () => true, ask: async () => 'x' }
    expect(await runBackup(disconnectEngine(status, calls), ['disconnect', flag], o)).toBe(1)
    expect(o.lines.join('\n')).toContain('connected by a Git URL')
    expect(calls).toEqual([])
  }
  expect(await runBackup(disconnectEngine(status, []), ['disconnect', '--revoke', '--delete-remote'], io())).toBe(2)
  expect(await runBackup(disconnectEngine(status, []), ['disconnect', '--confirm', 'a/b'], io())).toBe(2)
})

test('disconnectBackup takes its level over RPC', async () => {
  const calls: unknown[] = []
  const out: string[] = []
  const e = disconnectEngine(ghStatus, calls, [{ status: 'pending' }])
  expect(await runRpc(e, ['disconnectBackup', '-'], s => out.push(s), async () => '[{"level":"revoke"}]')).toBe(0)
  expect(await runRpc(e, ['startGitHubBackupDeleteSignIn', '-'], s => out.push(s), async () => '[]')).toBe(0)
  expect(await runRpc(e, ['pollGitHubBackupDeleteSignIn', '-'], s => out.push(s), async () => '["dc-1"]')).toBe(0)
  expect(out.map(l => JSON.parse(l).ok)).toEqual([true, true, true])
  expect(calls).toEqual([['disconnect', { level: 'revoke' }], ['start-delete']])
})
