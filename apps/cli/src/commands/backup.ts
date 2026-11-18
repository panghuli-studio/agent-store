import { createInterface } from 'readline'
import type {
  BackupAppliedChange, BackupConnectResult, BackupConflictChoice, BackupExcludedFile, BackupFailure, BackupItemRef, BackupLocalOnly,
  BackupMissingSecret, BackupSyncResult, Engine, BackupConflict,
} from '@as/types'
import { formatTable } from '../utils/format'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, errorMessage } from '../utils/exit-codes'
import { readSecret } from './projects'

const USAGE = `Usage: aas backup <command>

  connect --github [--device <name>] [--new]
                              Sign in with GitHub (device code) and connect to a private
                              repository it creates, or to the backup an earlier device made
                              there; --new creates a new one even when a backup is found
  connect <git-url> [--branch <b>] [--device <name>] [--username <u>] [--token-stdin]
                              Connect this device to a Git repository you own (empty, or an
                              Agent Store backup). HTTPS tokens are read from stdin
  status [--fetch]            Connection, last sync, local changes, conflicts, missing keys
  now                         Snapshot, then sync both ways: upload local changes, apply remote ones
  pull                        Apply remote changes here without uploading local ones
  conflicts                   Items changed on both sides, waiting for a choice
  resolve <item> <local|remote|both>
                              Keep this machine's version, take the remote one, or keep both
                              (the remote one is installed as <slug>-<device>, not enabled)
  snapshots                   Local snapshots taken before each sync, choice and restore
  restore <snapshot>          Make this machine match a snapshot (snapshots the current state first)
  log [--limit N]             Backup commits and the device that made each
  disconnect                  Forget the connection on this device; the remote is left as it is

<item> is a slug or <kind>/<slug>. Keys and tokens are never uploaded.`

export interface BackupIo {
  out: (s: string) => void
  readSecret: (question: string) => Promise<string>
  /** A yes/no answer; null when nobody can answer (stdin is not a terminal). */
  confirm?: (question: string) => Promise<boolean | null>
  /** Waits `ms`; resolves false when the user cancelled (Ctrl-C). */
  wait?: (ms: number) => Promise<boolean>
}

function confirm(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null)
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => {
      rl.close()
      resolve(!/^\s*n/i.test(answer))
    })
  })
}

// Ctrl-C while waiting for the approval ends the wait instead of the process, so the sign-in is cancelled cleanly.
let interrupted = false
function wait(ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const onInt = () => { interrupted = true; clearTimeout(timer); resolve(false) }
    const timer = setTimeout(() => { process.off('SIGINT', onInt); resolve(!interrupted) }, ms)
    process.once('SIGINT', onInt)
  })
}

const defaultIo: BackupIo = { out: console.log, readSecret, confirm, wait }

function printConnected(r: BackupConnectResult, out: (s: string) => void): void {
  out(`  Connected to ${r.status.remote} (branch ${r.status.branch}) as ${r.status.device}`)
  if (r.remoteItems) out(`  The backup holds ${r.remoteItems} item(s). Install them here with: aas backup pull (or aas backup now to merge both ways)`)
  else out('  The backup is empty. Upload this machine with: aas backup now')
}

const RETRY = 'Nothing was connected; try again with: aas backup connect --github'

async function connectGitHub(engine: Engine, opts: { device?: string; fresh: boolean }, io: BackupIo): Promise<number> {
  const { out } = io
  const pause = io.wait ?? (async (ms: number) => { await new Promise(r => setTimeout(r, ms)); return true })
  const code = await engine.startGitHubBackupSignIn()
  out(`  Open ${code.verificationUri} and enter the code: ${code.userCode}`)
  out(`  The code expires in ${Math.round(code.expiresIn / 60)} minutes. Agent Store asks for the "repo" scope, to create a private repository and push to it.`)
  out('  Waiting for the approval on GitHub (Ctrl-C to cancel)…')
  const deadline = Date.now() + code.expiresIn * 1000
  let interval = code.interval * 1000
  for (;;) {
    if (!(await pause(interval))) {
      out(`  Cancelled. ${RETRY}`)
      return EXIT_FAILURE
    }
    if (Date.now() >= deadline) { out(`  The code expired before it was approved. ${RETRY}`); return EXIT_FAILURE }
    const poll = await engine.pollGitHubBackupSignIn(code.deviceCode)
    if (poll.status === 'pending') continue
    if (poll.status === 'slow_down') { interval = Math.max(interval + 5000, poll.interval * 1000); continue }
    if (poll.status === 'denied') { out(`  The sign-in was denied on GitHub. ${RETRY}`); return EXIT_FAILURE }
    if (poll.status === 'expired') { out(`  The code expired before it was approved. ${RETRY}`); return EXIT_FAILURE }
    out(`  Signed in to GitHub as ${poll.login}`)
    let repo: 'existing' | 'new' = 'new'
    if (poll.existing && !opts.fresh) {
      const visibility = poll.existing.private ? 'private' : 'PUBLIC'
      out(`  Found the backup an earlier device made: ${poll.existing.fullName} (${visibility})`)
      const yes = await (io.confirm ?? (async () => null))(`  Connect to it? [Y/n] `)
      if (yes === false) out(`  Creating ${poll.create} instead`)
      else repo = 'existing'
    } else {
      out(`  Creating the private repository ${poll.create}`)
    }
    try {
      const r = await engine.connectGitHubBackup({ repo, ...(opts.device ? { device: opts.device } : {}) })
      printConnected(r, out)
      return EXIT_OK
    } catch (err) {
      await engine.cancelGitHubBackupSignIn().catch(() => undefined)
      throw err
    }
  }
}

const names = (items: BackupItemRef[]) => items.map(i => i.key).join(', ')

function printConflicts(conflicts: BackupConflict[], out: (s: string) => void): void {
  if (!conflicts.length) return
  const why = { 'both-changed': 'changed on both sides', 'deleted-here': 'removed here, changed there', 'deleted-there': 'changed here, removed there' }
  formatTable(['ITEM', 'CONFLICT', 'PARTS', 'REMOTE DEVICE'],
    conflicts.map(c => [c.key, why[c.reason], c.parts.join('+'), c.remoteDevice ?? '-']), [30, 28, 14, 20])
    .forEach(l => out(`  ${l}`))
  out(`  Choose with: aas backup resolve <item> <local|remote|both>`)
}

function printMissing(missing: BackupMissingSecret[], out: (s: string) => void): void {
  for (const m of missing) {
    out(`  Missing key: ${m.key} (wanted for ${m.targets.join(', ')}); set it with: aas config ${m.slug}, then aas enable ${m.slug} --for <tool>`)
  }
}

function printFailed(failed: BackupFailure[], out: (s: string) => void): void {
  for (const f of failed) out(`  Not applied: ${f.key}: ${f.message} (retried on the next sync)`)
}

function printLocal(localOnly: BackupLocalOnly[], excluded: BackupExcludedFile[], out: (s: string) => void): void {
  for (const l of localOnly) {
    out(l.reason === 'imported-mcp'
      ? `  Kept on this machine only: ${l.key} was imported from your own config and holds its values as written`
      : `  Kept on this machine only: ${l.key} is over the size limit${l.bytes ? ` (${Math.round(l.bytes / 1024 / 1024)} MB)` : ''}`)
  }
  for (const e of excluded) out(`  Not uploaded: ${e.key}/${e.file} (${e.reason === 'git-dir' ? 'a Git directory' : e.reason === 'owner-only' ? 'readable by its owner only' : 'looks like a secret file'})`)
}

function printApplied(applied: BackupAppliedChange[], out: (s: string) => void): void {
  for (const a of applied) out(`  ${a.key}: ${a.actions.join(', ')}`)
}

function printSync(r: BackupSyncResult, out: (s: string) => void): void {
  out(`  State before this run: snapshot ${r.snapshot}`)
  out(r.pushed ? `  Uploaded ${r.uploaded.length} item(s): ${names(r.uploaded)} (${r.pushed.slice(0, 10)})` : '  Nothing to upload')
  if (r.applied.length) {
    out(`  Applied from the backup:`)
    printApplied(r.applied, out)
  } else {
    out('  Nothing to apply from the backup')
  }
  printConflicts(r.conflicts, out)
  printMissing(r.missingSecrets, out)
  printFailed(r.failed, out)
  printLocal(r.localOnly, r.excludedFiles, out)
  for (const n of r.notRestorable) out(`  Not available here: ${n.key} is too large to be in the backup`)
}

export async function runBackup(engine: Engine, args: string[], io: BackupIo = defaultIo): Promise<number> {
  const { out } = io
  const [sub, ...rest] = args
  const usage = (why?: string) => { if (why) out(`  Error: ${why}`); out(USAGE); return EXIT_USAGE }
  try {
    switch (sub) {
      case 'connect': {
        const opts: { branch?: string; device?: string; username?: string } = {}
        let tokenFromStdin = false
        let github = false
        let fresh = false
        const urls: string[] = []
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i]
          if (a === '--branch' || a === '--device' || a === '--username') {
            const v = rest[++i]
            if (!v) return usage(`${a} needs a value`)
            opts[a.slice(2) as 'branch' | 'device' | 'username'] = v
          } else if (a === '--token-stdin') tokenFromStdin = true
          else if (a === '--github') github = true
          else if (a === '--new') fresh = true
          else if (a === '--token') return usage('the token is read from stdin: pass --token-stdin')
          else if (a.startsWith('-')) return usage(`unknown option ${a}`)
          else urls.push(a)
        }
        if (github) {
          if (urls.length || tokenFromStdin || opts.branch || opts.username) return usage('--github takes only --device and --new')
          return await connectGitHub(engine, { device: opts.device, fresh }, io)
        }
        if (fresh) return usage('--new goes with --github')
        if (urls.length !== 1) return usage()
        const token = tokenFromStdin ? (await io.readSecret('  Token: ')).trim() : undefined
        if (tokenFromStdin && !token) { out('  Error: no token given; nothing was connected'); return EXIT_FAILURE }
        const r = await engine.connectBackup({ remote: urls[0], ...opts, ...(token ? { token } : {}) })
        printConnected(r, out)
        return EXIT_OK
      }
      case 'status': {
        const fetch = rest.includes('--fetch')
        if (rest.some(a => a !== '--fetch')) return usage()
        const s = await engine.getBackupStatus({ fetch })
        if (!s.connected) { out('  Not connected. Connect with: aas backup connect --github, or aas backup connect <git-url>'); return EXIT_OK }
        out(`  Remote: ${s.remote} (branch ${s.branch})${s.github ? `, signed in to GitHub as ${s.github.login}` : s.hasCredentials ? ', token stored on this machine' : ''}`)
        out(`  Device: ${s.device}`)
        out(`  Last sync: ${s.lastSync ? `${s.lastSync.at} (${s.lastSync.commit.slice(0, 10)})` : 'never'}`)
        out(`  Local changes: ${s.localChanges.length ? names(s.localChanges) : 'none'}`)
        if (s.remoteAhead !== null) out(`  Remote commits not applied here: ${s.remoteAhead}`)
        for (const f of s.secretFindings) out(`  Blocked: ${f.file} contains ${f.what}; nothing can be backed up until it is removed`)
        printConflicts(s.conflicts, out)
        printMissing(s.missingSecrets, out)
        printFailed(s.failed, out)
        printLocal(s.localOnly, s.excludedFiles, out)
        for (const n of s.notRestorable) out(`  Not available here: ${n.key} is too large to be in the backup`)
        return EXIT_OK
      }
      case 'now':
      case 'pull': {
        if (rest.length) return usage()
        const r = sub === 'now' ? await engine.backupNow() : await engine.pullBackup()
        printSync(r, out)
        return r.failed.length ? EXIT_FAILURE : EXIT_OK
      }
      case 'conflicts': {
        if (rest.length) return usage()
        const s = await engine.getBackupStatus()
        if (!s.connected) { out('  Not connected. Connect with: aas backup connect --github, or aas backup connect <git-url>'); return EXIT_OK }
        if (!s.conflicts.length) { out('  No conflicts'); return EXIT_OK }
        printConflicts(s.conflicts, out)
        return EXIT_OK
      }
      case 'resolve': {
        const [item, choice] = rest
        if (rest.length !== 2 || !['local', 'remote', 'both'].includes(choice)) return usage()
        const r = await engine.resolveBackupConflict(item, choice as BackupConflictChoice)
        out(`  Undo with: aas backup restore ${r.snapshot}`)
        if (r.keptAs) out(`  Kept both: the remote version is installed as ${r.keptAs}, not enabled`)
        printApplied(r.applied, out)
        printMissing(r.missingSecrets, out)
        out(`  ${r.item.key} resolved; upload with: aas backup now`)
        return EXIT_OK
      }
      case 'snapshots': {
        if (rest.length) return usage()
        const list = await engine.listBackupSnapshots()
        if (!list.length) { out('  No snapshots yet'); return EXIT_OK }
        formatTable(['ID', 'TAKEN', 'REASON'], list.map(s => [s.id, s.createdAt, s.reason]), [20, 26, 40]).forEach(l => out(`  ${l}`))
        return EXIT_OK
      }
      case 'restore': {
        if (rest.length !== 1) return usage()
        const r = await engine.restoreBackupSnapshot(rest[0])
        out(`  Undo with: aas backup restore ${r.snapshot}`)
        if (r.applied.length) printApplied(r.applied, out)
        else out('  Already matches the snapshot')
        printMissing(r.missingSecrets, out)
        printFailed(r.failed, out)
        for (const n of r.notRestorable) out(`  Not restored: ${n.key} was too large to be in the snapshot`)
        out('  Upload the restored state with: aas backup now')
        return r.failed.length ? EXIT_FAILURE : EXIT_OK
      }
      case 'log': {
        let limit: number | undefined
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--limit') limit = Number(rest[++i])
          else return usage()
        }
        if (limit !== undefined && !(limit > 0)) return usage('--limit needs a positive number')
        const entries = await engine.listBackupHistory(limit ? { limit } : undefined)
        if (!entries.length) { out('  No backup commits yet'); return EXIT_OK }
        formatTable(['COMMIT', 'DEVICE', 'AT', 'SUBJECT'], entries.map(e => [e.commit.slice(0, 10), e.device, e.at, e.subject]), [10, 20, 26, 40])
          .forEach(l => out(`  ${l}`))
        return EXIT_OK
      }
      case 'disconnect': {
        if (rest.length) return usage()
        await engine.disconnectBackup()
        out('  Disconnected this device; the remote repository was left as it is')
        return EXIT_OK
      }
      default:
        return usage(sub ? `unknown backup command ${sub}` : undefined)
    }
  } catch (err) {
    out(`  Error: ${errorMessage(err)}`)
    return EXIT_FAILURE
  }
}
