import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as persistence from '../../state/LocalPersistence'
import * as rpc from '../../lib/rpc'
import { AppStateProvider, useAppState } from '../../state/AppState'
import { BackupProvider } from '../../state/Backup'
import { TerminalLogProvider } from '../../state/TerminalLog'
import { useFirstRunWelcome } from '../WelcomeDialog'
import { FirstLaunchBackup } from '../backup/FirstLaunchBackup'
import { BackupDialogs } from '../backup/BackupDialogs'
import { settleRpc } from '../../test/settle'

const empty = { connected: false, localChanges: [], remoteAhead: null, conflicts: [], missingSecrets: [], failed: [], localOnly: [], notRestorable: [], excludedFiles: [], secretFindings: [] }
const never = { debounceMs: 1e9, remoteCheckMs: 1e9, initialDelayMs: 1e9, pollMs: 1e9 }

afterEach(async () => { cleanup(); await settleRpc(); mock.restore() })

function Probe() {
  useFirstRunWelcome()
  const { shellDialog } = useAppState()
  return <span data-testid="shell">{shellDialog}</span>
}

function setup(options: { saved?: Record<string, unknown>; installed?: unknown[]; failPull?: boolean; failSave?: boolean } = {}) {
  const saved = options.saved ?? {}
  const calls: [string, unknown[]][] = []
  let connected = false
  spyOn(persistence, 'readLocalState').mockImplementation((async (key: string, fallback: unknown) => saved[key] ?? fallback) as typeof persistence.readLocalState)
  spyOn(persistence, 'writeLocalState').mockImplementation(async (key, value) => {
    if (options.failSave) throw new Error('disk full')
    saved[key] = value
  })
  spyOn(rpc, 'callRpc').mockImplementation((async (method: string, args: unknown[] = []) => {
    calls.push([method, args])
    if (method === 'list') return options.installed ?? []
    if (method === 'getBackupStatus') return { ...empty, connected }
    if (method === 'connectBackup') { connected = true; return { status: { ...empty, connected }, remoteItems: 1 } }
    if (method === 'disconnectBackup') { connected = false; return }
    if (method === 'pullBackup') {
      if (options.failPull) throw new Error('restore rolled back')
      return { ...empty, pushed: null, uploaded: [], applied: [], snapshot: 'before' }
    }
    throw new Error(`unexpected RPC: ${method}`)
  }) as typeof rpc.callRpc)
  render(<AppStateProvider><TerminalLogProvider><BackupProvider timing={never}><Probe /><FirstLaunchBackup /><BackupDialogs /></BackupProvider></TerminalLogProvider></AppStateProvider>)
  return { saved, calls }
}

test('empty first launch asks once; start fresh continues welcome without writing library data', async () => {
  const { saved, calls } = setup()
  fireEvent.click(await screen.findByRole('button', { name: '从空白开始' }))
  await waitFor(() => expect(screen.getByTestId('shell').textContent).toBe('welcome'))
  expect(saved['first-launch-backup']).toBe(true)
  expect(calls.map(([method]) => method).filter(m => !['list', 'getBackupStatus'].includes(m))).toEqual([])
})

for (const [name, options] of [
  ['installed library', { installed: [{ slug: 'notes' }] }],
  ['saved choice', { saved: { 'first-launch-backup': true } }],
  ['completed welcome', { saved: { welcome: { seenAt: 'today' } } }],
] as const) {
  test(`does not ask with ${name}`, async () => {
    setup(options as Parameters<typeof setup>[0])
    await settleRpc()
    expect(screen.queryByRole('button', { name: '从备份恢复…' })).toBeNull()
  })
}

test('a persistence failure keeps the choice open', async () => {
  setup({ failSave: true })
  fireEvent.click(await screen.findByRole('button', { name: '从空白开始' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('无法保存')
  expect(screen.getByRole('button', { name: '从备份恢复…' })).toBeInTheDocument()
})

async function connect() {
  fireEvent.click(await screen.findByRole('button', { name: '从备份恢复…' }))
  const remote = await screen.findByLabelText('仓库地址')
  fireEvent.change(remote, { target: { value: '/tmp/backup.git' } })
  fireEvent.submit(remote.closest('form')!)
}

test('cancelling before connecting does not pull; the choice remains saved', async () => {
  const { calls, saved } = setup()
  fireEvent.click(await screen.findByRole('button', { name: '从备份恢复…' }))
  fireEvent.click(await screen.findByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(saved['first-launch-backup']).toBe(true)
  expect(calls.some(([m]) => m === 'pullBackup' || m === 'connectBackup')).toBe(false)
})

test('first-launch restore pulls with rollback enabled and never offers upload', async () => {
  const { calls } = setup()
  await connect()
  const pull = await screen.findByRole('button', { name: '恢复到本机' })
  fireEvent.click(pull)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(calls.find(([m]) => m === 'pullBackup')?.[1]).toEqual([{ firstRun: true }])
  expect(calls.some(([m]) => m === 'backupNow')).toBe(false)
})

test('a failed pull stays visible with an explicit way to cancel and disconnect', async () => {
  const { calls } = setup({ failPull: true })
  await connect()
  fireEvent.click(await screen.findByRole('button', { name: '恢复到本机' }))
  expect(await screen.findByText('restore rolled back')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '稍后' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(calls.some(([m]) => m === 'disconnectBackup')).toBe(true)
})
