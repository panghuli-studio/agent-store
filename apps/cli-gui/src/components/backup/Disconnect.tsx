import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { ExternalLink, Github } from 'lucide-react'
import type { BackupDisconnectLevel, BackupDisconnectResult, GitHubDeleteSignInPoll, GitHubDeviceCode } from '@as/types'
import { useT } from '../../i18n'
import { describeBackupError } from '../../lib/backup'
import type { FriendlyError } from '../../lib/errors'
import { openExternal } from '../../lib/openExternal'
import { errorText, RpcError } from '../../lib/rpc'
import { useBackup } from '../../state/Backup'
import { useTerminalLog } from '../../state/TerminalLog'
import { ErrorDetails, Section, Steps } from '../library/parts'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'
import { DialogBody, DialogFooter, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Banner, Spinner } from '../ui/states'
import { toast } from '../ui/toast'
import { DeviceCodeWait } from './GitHubConnect'

/** The device flow asks for `interval` seconds between polls; slow_down adds to it. */
const SLOW_DOWN_MS = 5_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fmt(template: string, ...values: (string | number)[]): string {
  return values.reduce<string>((s, v, i) => s.replace(`{${i}}`, String(v)), template)
}

type Flow =
  | { step: 'choose'; error?: FriendlyError; ended?: 'denied' | 'expired' | 'cancelled' }
  | { step: 'starting' }
  | { step: 'waiting'; userCode: string; uri: string; expiresAt: number }
  | { step: 'running' }
  | { step: 'done'; result: BackupDisconnectResult }

const COMMAND: Record<BackupDisconnectLevel, string> = {
  device: 'aas backup disconnect',
  revoke: 'aas backup disconnect --revoke',
  delete: 'aas backup disconnect --delete-remote',
}

/** GitHub's own failures read as "nothing was connected" elsewhere; here nothing was deleted. */
function describe(err: unknown, t: (k: string) => string): FriendlyError {
  if (err instanceof RpcError && err.fields.reason === 'github-failed') return { message: t('bk.err.githubDisc'), detail: errorText(err) }
  return describeBackupError(err, t)
}

/**
 * The three levels of disconnecting (docs/backup-sync.md, "Disconnecting"): this computer only,
 * revoking the GitHub authorization, deleting the GitHub repository. Each is explained before it
 * runs and reports what was done and what remains on other devices.
 */
export function DisconnectBody({ onClose }: { onClose: () => void }) {
  const t = useT()
  const backup = useBackup()!
  const { appendLine } = useTerminalLog()
  // Captured once: the status turns to "not connected" as soon as the disconnect succeeds.
  const [github] = useState(() => (backup.status?.github?.repo ? { login: backup.status.github.login, repo: backup.status.github.repo } : null))
  const [level, setLevel] = useState<BackupDisconnectLevel>('device')
  const [typed, setTyped] = useState('')
  const [flow, setFlow] = useState<Flow>({ step: 'choose' })
  const run = useRef(0)
  /** Set once GitHub approved the deletion sign-in: the core holds a token until it is used or cancelled. */
  const approved = useRef(false)
  const doneButton = useRef<HTMLButtonElement>(null)

  const forget = () => {
    if (!approved.current) return
    approved.current = false
    void backup.read('cancelGitHubBackupSignIn').catch(() => undefined)
  }

  useEffect(
    () => () => {
      run.current++
      forget()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  useEffect(() => {
    if (flow.step === 'done') doneButton.current?.focus()
  }, [flow.step])

  const matches = !!github && typed.trim().toLowerCase() === github.repo.toLowerCase()

  function fail(err: unknown) {
    appendLine(`✗ ${errorText(err)}`, 'red')
    setFlow({ step: 'choose', error: describe(err, t) })
  }

  async function disconnect(id: number) {
    setFlow({ step: 'running' })
    try {
      const result = await backup.disconnect(level === 'device' ? undefined : { level, ...(level === 'delete' ? { confirm: typed.trim() } : {}) })
      approved.current = false
      if (run.current !== id) return
      appendLine(`✓ ${t('bk.discDoneT')}`, 'green')
      toast(t('bk.discDoneT'))
      setFlow({ step: 'done', result })
    } catch (err) {
      if (run.current !== id) return
      forget()
      fail(err)
    }
  }

  async function start() {
    const id = ++run.current
    const alive = () => run.current === id
    appendLine(`$ ${COMMAND[level]}${level === 'delete' && github ? ` --confirm ${github.repo}` : ''}`)
    if (level !== 'delete') return disconnect(id)
    approved.current = false
    setFlow({ step: 'starting' })
    let code: GitHubDeviceCode
    try {
      code = await backup.read<GitHubDeviceCode>('startGitHubBackupDeleteSignIn')
    } catch (err) {
      if (alive()) fail(err)
      return
    }
    if (!alive()) return
    const expiresAt = Date.now() + code.expiresIn * 1000
    setFlow({ step: 'waiting', userCode: code.userCode, uri: code.verificationUri, expiresAt })
    void openExternal(code.verificationUri).catch(() => undefined)
    let interval = code.interval * 1000
    for (;;) {
      await sleep(interval)
      if (!alive()) return
      if (Date.now() >= expiresAt) return setFlow({ step: 'choose', ended: 'expired' })
      let poll: GitHubDeleteSignInPoll
      try {
        poll = await backup.read<GitHubDeleteSignInPoll>('pollGitHubBackupDeleteSignIn', [code.deviceCode])
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
        appendLine(`✗ ${t(`bk.discEnded.${poll.status}`)}`, 'red')
        return setFlow({ step: 'choose', ended: poll.status })
      }
      approved.current = true
      appendLine(`✓ ${fmt(t('bk.ghSignedAs'), poll.login)}`, 'green')
      return disconnect(id)
    }
  }

  function cancel() {
    run.current++
    forget()
    setFlow({ step: 'choose', ended: 'cancelled' })
  }

  if (flow.step === 'done') return <DisconnectDone result={flow.result} buttonRef={doneButton} onClose={onClose} />

  if (flow.step !== 'choose') {
    let body: ReactNode
    if (flow.step === 'waiting') {
      body = <DeviceCodeWait title={t('bk.discSignInT')} userCode={flow.userCode} uri={flow.uri} expiresAt={flow.expiresAt} />
    } else {
      const text =
        flow.step === 'starting' ? t('bk.ghStarting') : level === 'delete' && github ? fmt(t('bk.discDeleting'), github.repo) : level === 'revoke' ? t('bk.discRevoking') : t('bk.discBtn')
      body = (
        <div className="grid justify-items-center gap-2.5 py-6 text-center">
          <Spinner className="h-7 w-7 border-[3px]" />
          <p className="text-[13px] text-fg-2">{text}</p>
        </div>
      )
    }
    return (
      <>
        <DialogBody>
          <DialogTitle>{t('bk.discT')}</DialogTitle>
          <div data-testid="backup-disconnect" data-step={flow.step}>
            {body}
          </div>
        </DialogBody>
        <DialogFooter>
          {flow.step === 'running' ? <Button disabled>{t('bk.discBtn')}</Button> : <Button onClick={cancel}>{t('bk.ghCancel')}</Button>}
        </DialogFooter>
      </>
    )
  }

  const options: { id: BackupDisconnectLevel; title: string; desc: string }[] = [
    { id: 'device', title: t('bk.discDevice'), desc: t('bk.discDeviceD') },
    { id: 'revoke', title: t('bk.discRevoke'), desc: t('bk.discRevokeD') },
    { id: 'delete', title: t('bk.discDelete'), desc: fmt(t('bk.discDeleteD'), github?.repo ?? '') },
  ]
  const repo = github?.repo ?? ''
  const will =
    level === 'device'
      ? [t('bk.discWillLocal')]
      : level === 'revoke'
        ? [t('bk.discWillRevoke'), t('bk.discWillLocal')]
        : [t('bk.discWillSignIn'), fmt(t('bk.discWillDelete'), repo), t('bk.discWillRevokeBoth'), t('bk.discWillLocal')]
  const wont =
    level === 'device'
      ? [t('bk.discWontRemote'), ...(github ? [t('bk.discWontAuth')] : []), t('bk.discWontLocal')]
      : level === 'revoke'
        ? [t('bk.discWontRemote'), t('bk.discWontOthers'), t('bk.discWontLocal')]
        : [t('bk.discWontInstalled')]

  return (
    <>
      <DialogBody>
        <DialogTitle>{t('bk.discT')}</DialogTitle>
        <fieldset className="mt-1 flex flex-col gap-2" data-testid="backup-disconnect" data-step="choose">
          <legend className="sr-only">{t('bk.discLevel')}</legend>
          {options.map((o) => {
            const disabled = o.id !== 'device' && !github
            return (
              <label
                key={o.id}
                className={cn(
                  'flex gap-2.5 rounded-box border px-3 py-2.5 transition-colors',
                  disabled ? 'cursor-not-allowed border-line opacity-60' : 'cursor-pointer',
                  !disabled && (level === o.id ? (o.id === 'delete' ? 'border-bad/60 bg-panel-2' : 'border-mcp/60 bg-panel-2') : 'border-line hover:bg-panel')
                )}
              >
                <input
                  type="radio"
                  name="backup-disconnect-level"
                  value={o.id}
                  checked={level === o.id}
                  disabled={disabled}
                  onChange={() => {
                    setLevel(o.id)
                    setFlow({ step: 'choose' })
                  }}
                  className="mt-[3px] h-3.5 w-3.5 flex-none accent-[rgb(var(--mcp-rgb))]"
                />
                <span className="min-w-0">
                  <b className="block text-[13px] font-semibold text-fg">{o.title}</b>
                  <small className="block text-xs text-fg-3">{o.desc}</small>
                </span>
              </label>
            )
          })}
        </fieldset>
        {!github && <p className="mt-2 text-[12px] text-fg-3">{t('bk.discNotGithub')}</p>}
        <Section title={t('bk.discWill')} className="mt-3">
          <Steps lines={will} />
        </Section>
        <Section title={t('bk.discWont')} className="mt-3">
          <Steps lines={wont} />
        </Section>
        {level === 'delete' && github && (
          <div className="mt-3">
            <label htmlFor="backup-disconnect-confirm" className="mb-[5px] block text-[12.5px] font-semibold text-fg-2">
              {fmt(t('bk.discConfirm'), repo)}
            </label>
            <Input id="backup-disconnect-confirm" mono autoComplete="off" spellCheck={false} value={typed} placeholder={repo} onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}
        <p className="mt-3 text-[12px] text-fg-3">{level === 'device' ? t('bk.discAgain') : t('bk.discOrder')}</p>
        {flow.ended && (
          <div className="mt-3">
            <Banner tone="warn">
              <p>{t(`bk.discEnded.${flow.ended}`)}</p>
            </Banner>
          </div>
        )}
        {flow.error && (
          <div className="mt-3">
            <Banner tone="error" title={t('bk.failed.disconnect')}>
              <p>{flow.error.message}</p>
              <ErrorDetails detail={flow.error.detail} />
            </Banner>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button data-autofocus onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="danger" disabled={level === 'delete' && !matches} onClick={() => void start()}>
          {level === 'delete' && <Github />}
          {t(level === 'device' ? 'bk.discBtn' : level === 'revoke' ? 'bk.discRevokeBtn' : 'bk.discDeleteBtn')}
        </Button>
      </DialogFooter>
    </>
  )
}

function DisconnectDone({ result, buttonRef, onClose }: { result: BackupDisconnectResult; buttonRef: Ref<HTMLButtonElement>; onClose: () => void }) {
  const t = useT()
  const repo = result.repo ?? ''
  const done = [
    ...(result.repoDeleted ? [fmt(t(result.repoDeleted === 'deleted' ? 'bk.discDoneDeleted' : 'bk.discDoneGone'), repo)] : []),
    ...(result.revoked ? [t('bk.discDoneRevoked')] : []),
    t('bk.discDoneLocal'),
  ]
  const remains =
    result.level === 'delete'
      ? t('bk.discRemainsDelete')
      : result.level === 'revoke'
        ? t('bk.discRemainsRevoke')
        : `${t('bk.discRemainsDevice')}${result.repo ? ` ${t('bk.discRemainsGithub')}` : ''}`
  const authPage = result.level !== 'device' ? result.authorizationsUrl : undefined
  return (
    <>
      <DialogBody>
        <DialogTitle>{t('bk.discDoneT')}</DialogTitle>
        <div data-testid="backup-disconnect" data-step="done">
          <Section title={t('bk.discDone')} className="mt-3">
            <Steps lines={done} />
          </Section>
          <Section title={t('bk.discRemains')} className="mt-3">
            <p className="text-[13px] text-fg-2">{remains}</p>
          </Section>
          <Section title={t('bk.discWont')} className="mt-3">
            <Steps lines={[result.level === 'delete' ? t('bk.discWontInstalled') : t('bk.discWontLocal')]} />
          </Section>
          {authPage && <p className="mt-2 text-[12px] text-fg-3">{t('bk.discAuthPage')}</p>}
        </div>
      </DialogBody>
      <DialogFooter>
        {authPage && (
          <Button onClick={() => void openExternal(authPage).catch(() => undefined)}>
            <ExternalLink />
            {t('bk.discOpenAuth')}
          </Button>
        )}
        <Button ref={buttonRef} variant="primary" onClick={onClose}>
          {t('bk.discDoneBtn')}
        </Button>
      </DialogFooter>
    </>
  )
}
