import { test, expect, afterEach, beforeEach, spyOn, mock } from 'bun:test'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { BackupStatus, GitHubDeleteSignInPoll } from '@as/types'
import * as rpcModule from '../../lib/rpc'

const openMock = mock(async (_url: string) => {})
mock.module('../../lib/openExternal', () => ({ openExternal: openMock }))

const { AppStateProvider } = await import('../../state/AppState')
const { BackupProvider } = await import('../../state/Backup')
const { TerminalLogProvider, useTerminalLog } = await import('../../state/TerminalLog')
const { BackupTab } = await import('../backup/BackupTab')
const { BackupDialogs } = await import('../backup/BackupDialogs')
const { settleRpc } = await import('../../test/settle')
const { I18nProvider } = await import('../../i18n')

let locale = 'zh'
beforeEach(() => {
  openMock.mockClear()
  try { localStorage.setItem('as-locale', locale) } catch { /* ignore */ }
})
afterEach(async () => { cleanup(); await settleRpc(); mock.restore(); locale = 'zh' })

const NEVER = { debounceMs: 1e9, remoteCheckMs: 1e9, initialDelayMs: 1e9, pollMs: 1e9 }
const REPO = 'me/agent-store-backup'
const AUTH = 'https://github.com/settings/connections/applications/Iv1.x'

const empty: BackupStatus = {
  connected: false, localChanges: [], remoteAhead: null, conflicts: [], missingSecrets: [], failed: [], localOnly: [],
  notRestorable: [], excludedFiles: [], secretFindings: [],
}
const viaGitHub: BackupStatus = {
  ...empty, connected: true, remote: `https://github.com/${REPO}.git`, branch: 'main', device: 'desk-a',
  connectedAt: '2026-11-18T08:00:00Z', hasCredentials: true, github: { login: 'me', repo: REPO },
}
const viaUrl: BackupStatus = { ...viaGitHub, remote: 'git@example.com:me/backup.git', hasCredentials: false, github: undefined }
const CODE = { deviceCode: 'dc-9', userCode: 'ABCDEFGH', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 0 }

type H = Record<string, (...args: unknown[]) => unknown>
function mockRpc(start: BackupStatus, handlers: H = {}, polls: GitHubDeleteSignInPoll[] = [{ status: 'approved', login: 'me', repo: REPO }]) {
  let status = start
  const queue = [...polls]
  const calls: { method: string; args: unknown[] }[] = []
  const all: H = {
    getBackupStatus: () => status,
    listBackupSnapshots: () => [],
    listBackupHistory: () => [],
    cancelGitHubBackupSignIn: () => null,
    startGitHubBackupDeleteSignIn: () => CODE,
    pollGitHubBackupDeleteSignIn: () => (queue.length > 1 ? queue.shift() : queue[0]),
    disconnectBackup: (o?: unknown) => {
      const level = (o as { level?: string } | undefined)?.level ?? 'device'
      status = empty
      return {
        level, remote: start.remote, ...(start.github ? { repo: REPO } : {}),
        ...(level !== 'device' ? { revoked: true, authorizationsUrl: AUTH } : {}),
        ...(level === 'delete' ? { repoDeleted: 'deleted' } : {}),
      }
    },
    ...handlers,
  }
  spyOn(rpcModule, 'callRpc').mockImplementation((async (method: string, args: unknown[] = []) => {
    calls.push({ method, args })
    const h = all[method]
    if (!h) throw new Error(`unexpected RPC: ${method}`)
    return h(...args)
  }) as typeof rpcModule.callRpc)
  return calls
}

function Log() {
  const { lines } = useTerminalLog()
  return <div data-testid="log">{lines.map((l) => l.text).join('\n')}</div>
}

async function openDisconnect(button = '断开…') {
  render(
    <I18nProvider>
      <AppStateProvider>
        <TerminalLogProvider>
          <BackupProvider timing={NEVER}>
            <BackupTab />
            <BackupDialogs />
            <Log />
          </BackupProvider>
        </TerminalLogProvider>
      </AppStateProvider>
    </I18nProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: button }))
  return screen.findByRole('dialog')
}

const step = (dialog: HTMLElement) => within(dialog).getByTestId('backup-disconnect').getAttribute('data-step')

test('three levels, each explained before it runs; this computer only is the default', async () => {
  mockRpc(viaGitHub)
  const dialog = await openDisconnect()
  const device = within(dialog).getByRole('radio', { name: /只断开本机/ })
  expect(device).toBeChecked()
  expect(within(dialog).getByText(/GitHub 授权：不撤销/)).toBeInTheDocument()

  fireEvent.click(within(dialog).getByRole('radio', { name: /撤销 GitHub 授权/ }))
  expect(within(dialog).getByText(/在 GitHub 上撤销本机的令牌；GitHub 会发邮件/)).toBeInTheDocument()
  expect(within(dialog).getByText(/其他设备用各自的 GitHub 登录照常同步/)).toBeInTheDocument()
  expect(within(dialog).getByText(/任何一步失败都会停下/)).toBeInTheDocument()

  fireEvent.click(within(dialog).getByRole('radio', { name: /删除远端仓库/ }))
  expect(within(dialog).getByText(/授予 delete_repo 权限/)).toBeInTheDocument()
  expect(within(dialog).getByText(`在 GitHub 上删除 ${REPO}，所有设备的备份记录都在里面，一起删除`)).toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: '登录 GitHub 并删除' })).toBeDisabled()
})

test('revoke runs disconnectBackup with the level and reports what other devices keep', async () => {
  const calls = mockRpc(viaGitHub)
  const dialog = await openDisconnect()
  fireEvent.click(within(dialog).getByRole('radio', { name: /撤销 GitHub 授权/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: '撤销并断开' }))
  expect(await within(dialog).findByText('已断开')).toBeInTheDocument()
  expect(calls.find((c) => c.method === 'disconnectBackup')?.args).toEqual([{ level: 'revoke' }])
  expect(within(dialog).getByText('在 GitHub 上撤销了本机的令牌')).toBeInTheDocument()
  expect(within(dialog).getByText(/不受这次撤销影响/)).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: '打开 GitHub 授权页面' }))
  expect(openMock).toHaveBeenCalledWith(AUTH)
  expect(screen.getByTestId('log').textContent).toContain('$ aas backup disconnect --revoke')
})

test('delete: type the name, sign in for delete_repo, then delete; the result says other devices must disconnect', async () => {
  const calls = mockRpc(viaGitHub, {}, [{ status: 'pending' }, { status: 'approved', login: 'me', repo: REPO }])
  const dialog = await openDisconnect()
  fireEvent.click(within(dialog).getByRole('radio', { name: /删除远端仓库/ }))
  const input = within(dialog).getByLabelText(`输入仓库名 ${REPO} 确认删除`)
  fireEvent.change(input, { target: { value: 'me/agent-store' } })
  expect(within(dialog).getByRole('button', { name: '登录 GitHub 并删除' })).toBeDisabled()
  fireEvent.change(input, { target: { value: REPO } })
  fireEvent.click(within(dialog).getByRole('button', { name: '登录 GitHub 并删除' }))

  expect(await within(dialog).findByText('已断开')).toBeInTheDocument()
  expect(calls.filter((c) => c.method === 'pollGitHubBackupDeleteSignIn').map((c) => c.args)).toEqual([['dc-9'], ['dc-9']])
  expect(calls.find((c) => c.method === 'disconnectBackup')?.args).toEqual([{ level: 'delete', confirm: REPO }])
  expect(openMock).toHaveBeenCalledWith('https://github.com/login/device')
  expect(within(dialog).getByText(`在 GitHub 上删除了 ${REPO}`)).toBeInTheDocument()
  expect(within(dialog).getByText(/请在每台设备上选「只断开本机」/)).toBeInTheDocument()
  expect(calls.some((c) => c.method === 'cancelGitHubBackupSignIn')).toBe(false)
})

test('the deletion sign-in shows the code; cancelling it changes nothing', async () => {
  const calls = mockRpc(viaGitHub, {}, [{ status: 'pending' }])
  const dialog = await openDisconnect()
  fireEvent.click(within(dialog).getByRole('radio', { name: /删除远端仓库/ }))
  fireEvent.change(within(dialog).getByLabelText(`输入仓库名 ${REPO} 确认删除`), { target: { value: REPO } })
  fireEvent.click(within(dialog).getByRole('button', { name: '登录 GitHub 并删除' }))
  expect(await within(dialog).findByTestId('backup-user-code')).toHaveTextContent('ABCD-EFGH')
  expect(within(dialog).getByText('授权删除仓库')).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: '取消登录' }))
  expect(await within(dialog).findByText('已取消，什么都没有删除。')).toBeInTheDocument()
  expect(step(dialog)).toBe('choose')
  expect(calls.some((c) => c.method === 'disconnectBackup')).toBe(false)
})

test('a failed step is named, the connection stays, and the deletion sign-in is dropped', async () => {
  const calls = mockRpc(viaGitHub, {
    disconnectBackup: () => {
      throw new rpcModule.RpcError(`Deleting the repository ${REPO} on GitHub failed: GitHub answered 403 (Must have admin rights to Repository.). Nothing was deleted and nothing on this device was changed`, 'BackupDisconnectError', { reason: 'delete-failed' })
    },
  })
  const dialog = await openDisconnect()
  fireEvent.click(within(dialog).getByRole('radio', { name: /删除远端仓库/ }))
  fireEvent.change(within(dialog).getByLabelText(`输入仓库名 ${REPO} 确认删除`), { target: { value: REPO } })
  fireEvent.click(within(dialog).getByRole('button', { name: '登录 GitHub 并删除' }))
  expect(await within(dialog).findByText('断开失败')).toBeInTheDocument()
  expect(within(dialog).getByText(/没能在 GitHub 上删除仓库：仓库还在，本机也没有改动/)).toBeInTheDocument()
  await waitFor(() => expect(calls.some((c) => c.method === 'cancelGitHubBackupSignIn')).toBe(true))
  expect(step(dialog)).toBe('choose')
})

test('a Git URL connection offers only this computer, with the reason', async () => {
  mockRpc(viaUrl)
  const dialog = await openDisconnect()
  expect(within(dialog).getByRole('radio', { name: /撤销 GitHub 授权/ })).toBeDisabled()
  expect(within(dialog).getByRole('radio', { name: /删除远端仓库/ })).toBeDisabled()
  expect(within(dialog).getByText(/这个连接是用 Git 地址建立的/)).toBeInTheDocument()
  expect(within(dialog).queryByText(/GitHub 授权：不撤销/)).toBeNull()
})

test('in English', async () => {
  locale = 'en'
  try { localStorage.setItem('as-locale', 'en') } catch { /* ignore */ }
  mockRpc(viaGitHub)
  const dialog = await openDisconnect('Disconnect…')
  expect(within(dialog).getByRole('radio', { name: /This computer only/ })).toBeChecked()
  fireEvent.click(within(dialog).getByRole('radio', { name: /Delete the remote repository/ }))
  expect(within(dialog).getByLabelText(`Type the repository name, ${REPO}, to confirm`)).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('radio', { name: /revoke the GitHub authorization/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke and disconnect' }))
  expect(await within(dialog).findByText('Disconnected')).toBeInTheDocument()
  expect(within(dialog).getByText('Revoked this computer’s token on GitHub')).toBeInTheDocument()
})
