import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Copy, ExternalLink, Github } from 'lucide-react'
import type { BackupConnectResult, GitHubBackupRepo, GitHubDeviceCode, GitHubSignInPoll } from '@as/types'
import { useT } from '../../i18n'
import { describeBackupError } from '../../lib/backup'
import type { FriendlyError } from '../../lib/errors'
import { openExternal } from '../../lib/openExternal'
import { errorText } from '../../lib/rpc'
import { useBackup } from '../../state/Backup'
import { useTerminalLog } from '../../state/TerminalLog'
import { ErrorDetails } from '../library/parts'
import { formatUserCode } from '../shell/SignInDialog'
import { Button } from '../ui/button'
import { DialogBody, DialogFooter } from '../ui/dialog'
import { Input } from '../ui/input'
import { Banner, Spinner } from '../ui/states'
import { toast } from '../ui/toast'

/** The device flow asks for `interval` seconds between polls; slow_down adds to it. */
const SLOW_DOWN_MS = 5_000

type Ended = 'denied' | 'expired' | 'cancelled' | 'failed'

export type GitHubFlow =
  | { step: 'idle' }
  | { step: 'starting' }
  | { step: 'waiting'; userCode: string; uri: string; expiresAt: number }
  | { step: 'offer'; login: string; existing: GitHubBackupRepo; create: string }
  | { step: 'connecting'; login: string; target: string; creating: boolean }
  | { step: 'ended'; why: Ended; error?: FriendlyError }

function fmt(template: string, ...values: (string | number)[]): string {
  return values.reduce<string>((s, v, i) => s.replace(`{${i}}`, String(v)), template)
}

/** `template` with `{0}` replaced by a node, e.g. a code span. */
function withNode(template: string, node: ReactNode): ReactNode {
  const [before, after = ''] = template.split('{0}')
  return (
    <>
      {before}
      {node}
      {after}
    </>
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Sign in with GitHub's device code, then connect to the backup found on the account or to the
 * private repository the core creates. The token never reaches this window: the core keeps it.
 */
export function GitHubConnect({
  mode,
  header,
  onClose,
  onDone,
}: {
  mode: 'new' | 'restore'
  /** Title and method switch; `active` hides the switch while a sign-in runs. */
  header: (active: boolean) => ReactNode
  onClose: () => void
  onDone: (r: BackupConnectResult) => void
}) {
  const t = useT()
  const backup = useBackup()!
  const { appendLine } = useTerminalLog()
  const [flow, setFlow] = useState<GitHubFlow>({ step: 'idle' })
  const [device, setDevice] = useState('')
  const run = useRef(0)
  /** Set once GitHub approved: the core holds a token until it is connected or cancelled. */
  const approved = useRef(false)

  const forget = () => {
    if (!approved.current) return
    approved.current = false
    void backup.read('cancelGitHubBackupSignIn').catch(() => undefined)
  }

  // Closing the dialog mid-sign-in stops the polling and drops an approved, unconnected sign-in.
  useEffect(
    () => () => {
      run.current++
      forget()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  function fail(err: unknown) {
    appendLine(`✗ ${errorText(err)}`, 'red')
    setFlow({ step: 'ended', why: 'failed', error: describeBackupError(err, t) })
  }

  async function connect(id: number, login: string, repo: 'existing' | 'new', target: string) {
    setFlow({ step: 'connecting', login, target, creating: repo === 'new' })
    try {
      const r = await backup.connectGitHub({ repo, ...(device.trim() ? { device: device.trim() } : {}) })
      approved.current = false
      if (run.current !== id) return
      appendLine(`✓ ${fmt(t('bk.connectedTo'), r.status.remote ?? '', r.status.branch ?? '', r.status.device ?? '')}`, 'green')
      onDone(r)
    } catch (err) {
      if (run.current !== id) return
      forget()
      fail(err)
    }
  }

  async function start() {
    const id = ++run.current
    const alive = () => run.current === id
    approved.current = false
    setFlow({ step: 'starting' })
    appendLine(`$ aas backup connect --github${device.trim() ? ` --device ${device.trim()}` : ''}`)
    let code: GitHubDeviceCode
    try {
      code = await backup.read<GitHubDeviceCode>('startGitHubBackupSignIn')
    } catch (err) {
      if (alive()) fail(err)
      return
    }
    if (!alive()) return
    const expiresAt = Date.now() + code.expiresIn * 1000
    setFlow({ step: 'waiting', userCode: code.userCode, uri: code.verificationUri, expiresAt })
    void openExternal(code.verificationUri).catch(() => undefined)

    let interval = code.interval * 1000
    let poll: GitHubSignInPoll
    for (;;) {
      await sleep(interval)
      if (!alive()) return
      if (Date.now() >= expiresAt) return setFlow({ step: 'ended', why: 'expired' })
      try {
        poll = await backup.read<GitHubSignInPoll>('pollGitHubBackupSignIn', [code.deviceCode])
      } catch (err) {
        if (alive()) fail(err)
        return
      }
      if (!alive()) {
        if (poll.status === 'approved') {
          approved.current = true
          forget()
        }
        return
      }
      if (poll.status === 'pending') continue
      if (poll.status === 'slow_down') {
        interval = Math.max(interval + SLOW_DOWN_MS, poll.interval * 1000)
        continue
      }
      if (poll.status === 'denied' || poll.status === 'expired') {
        appendLine(`✗ ${t(poll.status === 'denied' ? 'bk.ghDeniedD' : 'bk.ghExpiredD')}`, 'red')
        return setFlow({ step: 'ended', why: poll.status })
      }
      break
    }
    approved.current = true
    appendLine(`✓ ${fmt(t('bk.ghSignedAs'), poll.login)}`, 'green')
    if (poll.existing) return setFlow({ step: 'offer', login: poll.login, existing: poll.existing, create: poll.create })
    await connect(id, poll.login, 'new', poll.create)
  }

  function cancel() {
    run.current++
    forget()
    setFlow({ step: 'ended', why: 'cancelled' })
  }

  const active = flow.step !== 'idle' && flow.step !== 'ended'
  const minutes = flow.step === 'waiting' ? Math.max(1, Math.round((flow.expiresAt - Date.now()) / 60_000)) : 0

  let body: ReactNode
  let footer: ReactNode
  if (flow.step === 'idle' || flow.step === 'ended') {
    body = (
      <>
        <p className="mb-3 text-[13px] text-fg-2">{t(mode === 'restore' ? 'bk.ghRestoreD' : 'bk.ghD')}</p>
        <div className="mb-3 max-w-[50%] pr-1.5">
          <label htmlFor="backup-gh-device" className="mb-[5px] block text-[12.5px] font-semibold text-fg-2">
            {t('bk.device')}
          </label>
          <Input id="backup-gh-device" autoComplete="off" spellCheck={false} value={device} placeholder={t('bk.devicePh')} onChange={(e) => setDevice(e.target.value)} />
          <p className="mt-1 text-[11.5px] text-fg-3">{t('bk.deviceHint')}</p>
        </div>
        <p className="text-[11.5px] text-fg-3">{t('bk.ghScope')}</p>
        {flow.step === 'ended' && (
          <div className="mt-3">
            <Banner tone={flow.why === 'failed' ? 'error' : 'warn'} title={t(`bk.gh${flow.why[0].toUpperCase()}${flow.why.slice(1)}T`)}>
              <p>{flow.error ? flow.error.message : t(`bk.gh${flow.why[0].toUpperCase()}${flow.why.slice(1)}D`)}</p>
              {flow.error && <ErrorDetails detail={flow.error.detail} />}
            </Banner>
          </div>
        )}
      </>
    )
    footer = (
      <>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" data-autofocus onClick={() => void start()}>
          <Github />
          {t(flow.step === 'ended' ? 'bk.ghRetry' : 'bk.ghSignIn')}
        </Button>
      </>
    )
  } else if (flow.step === 'starting') {
    body = (
      <div className="grid justify-items-center gap-2.5 py-6 text-center">
        <Spinner className="h-7 w-7 border-[3px]" />
        <p className="text-[13px] text-fg-2">{t('bk.ghStarting')}</p>
      </div>
    )
    footer = <Button onClick={cancel}>{t('bk.ghCancel')}</Button>
  } else if (flow.step === 'waiting') {
    body = (
      <div className="grid justify-items-center gap-2.5 pb-1.5 pt-3 text-center">
        <Spinner className="h-7 w-7 border-[3px]" />
        <h3 className="text-[15px] font-bold">{t('bk.ghWaitT')}</h3>
        <p className="max-w-[46ch] text-[13px] text-fg-2">
          {withNode(t('bk.ghWaitD'), <code className="font-mono text-[12px] text-fg">{flow.uri}</code>)}
        </p>
        <div className="mt-1 grid justify-items-center gap-1">
          <span className="text-[11.5px] text-fg-3">{t('bk.ghCode')}</span>
          <code data-testid="backup-user-code" className="rounded-ctl border border-line-strong bg-panel px-4 py-2 font-mono text-[22px] font-bold tracking-[0.14em] text-fg">
            {formatUserCode(flow.userCode)}
          </code>
          <span className="text-[11.5px] text-fg-3">{fmt(t('bk.ghValid'), minutes)}</span>
        </div>
        <div className="mt-1 flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              const done = navigator.clipboard?.writeText(flow.userCode)
              if (done) done.then(() => toast(t('bk.ghCopied')), () => undefined)
            }}
          >
            <Copy />
            {t('bk.ghCopy')}
          </Button>
          <Button size="sm" onClick={() => void openExternal(flow.uri).catch(() => undefined)}>
            <ExternalLink />
            {t('bk.ghOpen')}
          </Button>
        </div>
      </div>
    )
    footer = <Button onClick={cancel}>{t('bk.ghCancel')}</Button>
  } else if (flow.step === 'offer') {
    const id = run.current
    body = (
      <>
        <p className="mb-2 text-[12.5px] text-fg-3">{fmt(t('bk.ghSignedAs'), flow.login)}</p>
        <h3 className="mb-1 text-[14px] font-semibold text-fg">{t('bk.ghFoundT')}</h3>
        <p className="mb-3 text-[13px] text-fg-2">
          {withNode(t('bk.ghFoundD'), <code className="font-mono text-[12px] text-fg">{flow.existing.fullName}</code>)}
        </p>
        {!flow.existing.private && (
          <Banner tone="warn">
            <p>{t('bk.ghFoundPublic')}</p>
          </Banner>
        )}
      </>
    )
    footer = (
      <>
        <Button onClick={cancel}>{t('bk.ghCancel')}</Button>
        <Button onClick={() => void connect(id, flow.login, 'new', flow.create)}>{fmt(t('bk.ghCreateOther'), flow.create)}</Button>
        <Button variant="primary" autoFocus onClick={() => void connect(id, flow.login, 'existing', flow.existing.fullName)}>
          {t('bk.ghUse')}
        </Button>
      </>
    )
  } else {
    body = (
      <div className="grid justify-items-center gap-2.5 py-6 text-center">
        <Spinner className="h-7 w-7 border-[3px]" />
        <p className="text-[13px] text-fg-2">{fmt(t(flow.creating ? 'bk.ghCreating' : 'bk.ghConnecting'), flow.target)}</p>
        <p className="text-[12px] text-fg-3">{fmt(t('bk.ghSignedAs'), flow.login)}</p>
      </div>
    )
    footer = <Button disabled>{t('bk.connecting')}</Button>
  }

  return (
    <>
      <DialogBody>
        {header(active)}
        <div data-testid="backup-github" data-step={flow.step}>
          {body}
        </div>
      </DialogBody>
      <DialogFooter>{footer}</DialogFooter>
    </>
  )
}
