import { test, expect, afterEach, beforeEach, spyOn, mock } from 'bun:test'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { BackupStatus, GitHubSignInPoll } from '@as/types'
import * as rpcModule from '../../lib/rpc'

const openMock = mock(async (_url: string) => {})
mock.module('../../lib/openExternal', () => ({ openExternal: openMock }))

const { AppStateProvider } = await import('../../state/AppState')
const { BackupProvider } = await import('../../state/Backup')
const { TerminalLogProvider, useTerminalLog } = await import('../../state/TerminalLog')
const { BackupTab } = await import('../backup/BackupTab')
const { BackupDialogs } = await import('../backup/BackupDialogs')
const { settleRpc } = await import('../../test/settle')

let locale = 'zh'
beforeEach(() => {
  openMock.mockClear()
  try { localStorage.setItem('as-locale', locale) } catch { /* ignore */ }
})
afterEach(async () => { cleanup(); await settleRpc(); mock.restore(); locale = 'zh' })

const NEVER = { debounceMs: 1e9, remoteCheckMs: 1e9, initialDelayMs: 1e9, pollMs: 1e9 }

const empty: BackupStatus = {
  connected: false, localChanges: [], remoteAhead: null, conflicts: [], missingSecrets: [], failed: [], localOnly: [],
  notRestorable: [], excludedFiles: [], secretFindings: [],
}
const linked: BackupStatus = {
  ...empty, connected: true, remote: 'https://github.com/me/agent-store-backup.git', branch: 'main', device: 'desk-a',
  connectedAt: '2026-11-18T08:00:00Z', hasCredentials: true, github: { login: 'me' },
}
// interval 0: the dialog polls right away in tests.
const CODE = { deviceCode: 'dc-1', userCode: 'WDJBMJHT', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 0 }
const EXISTING = { fullName: 'me/agent-store-backup', private: true, url: 'https://github.com/me/agent-store-backup' }

type H = Record<string, (...args: unknown[]) => unknown>
function mockRpc(handlers: H) {
  const calls: { method: string; args: unknown[] }[] = []
  spyOn(rpcModule, 'callRpc').mockImplementation((async (method: string, args: unknown[] = []) => {
    calls.push({ method, args })
    const h = handlers[method] ?? ({ listBackupSnapshots: () => [], listBackupHistory: () => [], cancelGitHubBackupSignIn: () => null } as H)[method]
    if (!h) throw new Error(`unexpected RPC: ${method}`)
    return h(...args)
  }) as typeof rpcModule.callRpc)
  return calls
}

/** startGitHubBackupSignIn, then the polls in order (the last one repeats), then connectGitHubBackup. */
function gitHub(polls: GitHubSignInPoll[], extra: H = {}) {
  let status = empty
  const queue = [...polls]
  const calls = mockRpc({
    getBackupStatus: () => status,
    startGitHubBackupSignIn: () => CODE,
    pollGitHubBackupSignIn: () => (queue.length > 1 ? queue.shift() : queue[0]),
    connectGitHubBackup: () => {
      status = linked
      return { status, remoteItems: 0 }
    },
    ...extra,
  })
  return calls
}

function Log() {
  const { lines } = useTerminalLog()
  return <div data-testid="log">{lines.map((l) => l.text).join('\n')}</div>
}

async function openConnect(button: RegExp | string = '连接仓库…') {
  render(
    <AppStateProvider>
      <TerminalLogProvider>
        <BackupProvider timing={NEVER}>
          <BackupTab />
          <BackupDialogs />
          <Log />
        </BackupProvider>
      </TerminalLogProvider>
    </AppStateProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: button }))
  return screen.findByRole('dialog')
}

const step = (dialog: HTMLElement) => within(dialog).getByTestId('backup-github').getAttribute('data-step')

test('GitHub is the default: the code and the address are shown, then the private repository is created and connected', async () => {
  const calls = gitHub([{ status: 'pending' }, { status: 'approved', login: 'me', existing: null, create: 'me/agent-store-backup' }])
  const dialog = await openConnect()
  expect(within(dialog).getByRole('button', { name: /GitHub/, pressed: true })).toBeInTheDocument()
  expect(within(dialog).getByText(/只申请 repo 权限/)).toBeInTheDocument()
  fireEvent.change(within(dialog).getByLabelText('设备名'), { target: { value: 'desk-a' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '用 GitHub 登录' }))

  expect(await within(dialog).findByTestId('backup-user-code')).toHaveTextContent('WDJB-MJHT')
  expect(within(dialog).getByText('https://github.com/login/device')).toBeInTheDocument()
  expect(openMock).toHaveBeenCalledWith('https://github.com/login/device')
  // The method switch is hidden while the sign-in runs.
  expect(within(dialog).queryByRole('button', { name: 'Git 地址' })).toBeNull()

  expect(await within(dialog).findByText('已连接')).toBeInTheDocument()
  expect(calls.find((c) => c.method === 'connectGitHubBackup')?.args).toEqual([{ repo: 'new', device: 'desk-a' }])
  expect(calls.filter((c) => c.method === 'pollGitHubBackupSignIn').map((c) => c.args)).toEqual([['dc-1'], ['dc-1']])
  const log = screen.getByTestId('log').textContent ?? ''
  expect(log).toContain('$ aas backup connect --github --device desk-a')
  expect(log).toContain('已登录 GitHub：me')
  fireEvent.click(within(dialog).getByRole('button', { name: '稍后' }))
  expect(await screen.findByText(/GitHub 账号 me/)).toBeInTheDocument()
})

test('a backup an earlier device made is offered; connecting it or creating another', async () => {
  for (const [button, repo] of [['连接这个备份', 'existing'], ['另建 me/agent-store-backup-2', 'new']] as const) {
    const calls = gitHub([{ status: 'approved', login: 'me', existing: EXISTING, create: 'me/agent-store-backup-2' }])
    const dialog = await openConnect(/从备份恢复/)
    fireEvent.click(within(dialog).getByRole('button', { name: '用 GitHub 登录' }))
    expect(await within(dialog).findByText('找到了以前的备份')).toBeInTheDocument()
    expect(within(dialog).getByText('me/agent-store-backup')).toBeInTheDocument()
    expect(within(dialog).queryByText(/这个仓库是公开的/)).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: button }))
    expect(await within(dialog).findByText('已连接')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'connectGitHubBackup')?.args).toEqual([{ repo }])
    cleanup()
    await settleRpc()
    mock.restore()
  }
})

test('a public earlier backup is flagged; cancelling the offer forgets the sign-in', async () => {
  const calls = gitHub([{ status: 'approved', login: 'me', existing: { ...EXISTING, private: false }, create: 'me/agent-store-backup-2' }])
  const dialog = await openConnect()
  fireEvent.click(within(dialog).getByRole('button', { name: '用 GitHub 登录' }))
  expect(await within(dialog).findByText(/这个仓库是公开的/)).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: '取消登录' }))
  expect(await within(dialog).findByText('已取消登录')).toBeInTheDocument()
  await waitFor(() => expect(calls.some((c) => c.method === 'cancelGitHubBackupSignIn')).toBe(true))
  expect(calls.some((c) => c.method === 'connectGitHubBackup')).toBe(false)
})

test('denied, expired and cancelled sign-ins end with a reason and a retry', async () => {
  for (const [poll, title] of [[{ status: 'denied' }, '授权被拒绝'], [{ status: 'expired' }, '验证码已过期']] as const) {
    const calls = gitHub([poll])
    const dialog = await openConnect()
    fireEvent.click(within(dialog).getByRole('button', { name: '用 GitHub 登录' }))
    expect(await within(dialog).findByText(title)).toBeInTheDocument()
    expect(step(dialog)).toBe('ended')
    fireEvent.click(within(dialog).getByRole('button', { name: '重新登录' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'startGitHubBackupSignIn').length).toBe(2))
    expect(calls.some((c) => c.method === 'connectGitHubBackup')).toBe(false)
    cleanup()
    await settleRpc()
    mock.restore()
  }

  const calls = gitHub([{ status: 'pending' }])
  const dialog = await openConnect()
  fireEvent.click(within(dialog).getByRole('button', { name: '用 GitHub 登录' }))
  await within(dialog).findByTestId('backup-user-code')
  fireEvent.click(within(dialog).getByRole('button', { name: '取消登录' }))
  expect(await within(dialog).findByText('已取消登录')).toBeInTheDocument()
  expect(within(dialog).getByText(/没有连接任何仓库/)).toBeInTheDocument()
  const polls = calls.filter((c) => c.method === 'pollGitHubBackupSignIn').length
  await settleRpc()
  expect(calls.filter((c) => c.method === 'pollGitHubBackupSignIn').length).toBe(polls)
})

test('a build without the OAuth app says to use a Git URL; that path is one click away', async () => {
  gitHub([], {
    startGitHubBackupSignIn: () => {
      throw new rpcModule.RpcError('GitHub sign-in is not set up in this build of Agent Store', 'BackupGitHubError', { reason: 'github-not-configured' })
    },
  })
  const dialog = await openConnect()
  fireEvent.click(within(dialog).getByRole('button', { name: '用 GitHub 登录' }))
  expect(await within(dialog).findByText(/还没有配置 GitHub 登录/)).toBeInTheDocument()
  expect(within(dialog).getByText('没能通过 GitHub 连接')).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Git 地址' }))
  expect(within(dialog).getByLabelText('仓库地址')).toBeInTheDocument()
})

test('in English', async () => {
  locale = 'en'
  try { localStorage.setItem('as-locale', 'en') } catch { /* ignore */ }
  gitHub([{ status: 'pending' }])
  const dialog = await openConnect('Connect a repository…')
  expect(within(dialog).getByText(/Only the repo scope is asked for/)).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in with GitHub' }))
  expect(await within(dialog).findByText('Authorize in your browser')).toBeInTheDocument()
  expect(within(dialog).getByTestId('backup-user-code')).toHaveTextContent('WDJB-MJHT')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel sign-in' }))
  expect(await within(dialog).findByText('Sign-in cancelled')).toBeInTheDocument()
})
