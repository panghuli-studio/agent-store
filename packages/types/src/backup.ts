import type { ToolTarget } from './engine'

export type BackupItemCategory = 'skill' | 'mcp' | 'provider'

/** `key` is `<category>/<slug>`, the item's path under `items/` in the backup repository. */
export interface BackupItemRef {
  key: string
  category: BackupItemCategory
  slug: string
}

export interface BackupConnectOptions {
  /** Any Git remote: HTTPS, SSH or a local path. Credentials in an HTTPS URL are moved to the credentials file. */
  remote: string
  /** Defaults to the remote's default branch, else `main`. */
  branch?: string
  /** Shown as the author of this device's commits; defaults to the host name. */
  device?: string
  /** HTTPS only; stored in a 0600 file on this machine and handed to git through the environment. */
  username?: string
  token?: string
}

export type BackupConflictReason = 'both-changed' | 'deleted-here' | 'deleted-there'

export interface BackupConflict extends BackupItemRef {
  reason: BackupConflictReason
  /** Which parts differ: the item itself (files, manifest, config) and/or its per-agent enabled flags. */
  parts: Array<'content' | 'state'>
  /** Device that last changed the item on the remote. */
  remoteDevice?: string
  detectedAt: string
}

export type BackupConflictChoice = 'local' | 'remote' | 'both'

/** Wanted enabled by the backup, but blocked here until the user supplies a key or a required value. */
export interface BackupMissingSecret extends BackupItemRef {
  targets: ToolTarget[]
  reason: 'no-key' | 'needs-config'
  message: string
}

/** A remote change that could not be applied here; it is retried on the next sync. */
export interface BackupFailure extends BackupItemRef {
  message: string
  at: string
}

export interface BackupLocalOnly extends BackupItemRef {
  /** `imported-mcp`: an MCP entry taken over by `aas import`; it holds the user's own values, secrets included. */
  reason: 'too-large' | 'imported-mcp'
  bytes?: number
}

/** Files inside a skill directory that are never uploaded. */
export interface BackupExcludedFile extends BackupItemRef {
  file: string
  reason: 'git-dir' | 'secret-name' | 'owner-only'
}

export interface BackupStatus {
  connected: boolean
  remote?: string
  branch?: string
  device?: string
  connectedAt?: string
  hasCredentials?: boolean
  /** Set when the connection was made by signing in with GitHub. */
  github?: { login: string }
  lastSync?: { commit: string; at: string }
  /** Items that differ from the last sync and would be uploaded by `backupNow`. */
  localChanges: BackupItemRef[]
  /** Commits on the remote since the last sync; null unless fetched. */
  remoteAhead: number | null
  conflicts: BackupConflict[]
  missingSecrets: BackupMissingSecret[]
  failed: BackupFailure[]
  localOnly: BackupLocalOnly[]
  /** Too large to back up on the device that has them; not available here. */
  notRestorable: BackupItemRef[]
  excludedFiles: BackupExcludedFile[]
  /** Set when the local state holds a secret; nothing can be backed up until it is removed. */
  secretFindings: Array<{ file: string; what: string }>
}

export interface BackupConnectResult {
  status: BackupStatus
  /** Items already in the remote; a first `pullBackup` installs them here. */
  remoteItems: number
}

export type BackupChangeAction = 'installed' | 'updated' | 'removed' | 'enabled' | 'disabled'

export interface BackupAppliedChange extends BackupItemRef {
  actions: BackupChangeAction[]
}

export interface BackupSyncResult {
  /** The commit now on the remote, when this run pushed one. */
  pushed: string | null
  uploaded: BackupItemRef[]
  applied: BackupAppliedChange[]
  /** Snapshot of the state before this run: taken now, or the newest one when nothing changed since. */
  snapshot: string
  conflicts: BackupConflict[]
  missingSecrets: BackupMissingSecret[]
  failed: BackupFailure[]
  localOnly: BackupLocalOnly[]
  notRestorable: BackupItemRef[]
  excludedFiles: BackupExcludedFile[]
}

export interface BackupResolveResult {
  item: BackupItemRef
  choice: BackupConflictChoice
  /** For `both`: the slug the remote version was installed under, not enabled. */
  keptAs?: string
  /** Restoring it undoes the choice. */
  snapshot: string
  applied: BackupAppliedChange[]
  missingSecrets: BackupMissingSecret[]
}

export interface BackupSnapshot {
  id: string
  createdAt: string
  reason: string
}

export interface BackupRestoreResult {
  /** Snapshot of the state before the restore. */
  snapshot: string
  applied: BackupAppliedChange[]
  missingSecrets: BackupMissingSecret[]
  failed: BackupFailure[]
  notRestorable: BackupItemRef[]
}

export interface BackupHistoryEntry {
  commit: string
  device: string
  at: string
  subject: string
}

/** The code to show the user, from GitHub's device flow (docs/backup-sync.md, "Connecting with GitHub"). */
export interface GitHubDeviceCode {
  /** Passed back to pollGitHubBackupSignIn; it is not the token. */
  deviceCode: string
  /** What the user types at `verificationUri`, e.g. `WDJB-MJHT`. */
  userCode: string
  /** https://github.com/login/device */
  verificationUri: string
  /** Seconds until the code expires. */
  expiresIn: number
  /** Seconds to wait between polls. */
  interval: number
}

/** A repository on the signed-in account; `fullName` is `<owner>/<name>`. */
export interface GitHubBackupRepo {
  fullName: string
  private: boolean
  url: string
}

/**
 * One poll. On `approved` the token stays in the core (backup/github-signin.json, 0600) until
 * connectGitHubBackup or cancelGitHubBackupSignIn; it is never returned.
 */
export type GitHubSignInPoll =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | {
      status: 'approved'
      login: string
      /** A backup an earlier device made on this account, offered for connecting. */
      existing: GitHubBackupRepo | null
      /** The private repository `connectGitHubBackup({ repo: 'new' })` creates (or reuses when it is empty). */
      create: string
    }

export interface GitHubConnectOptions {
  /** `existing`: the backup offered by the approved poll; `new`: create the private repository. */
  repo: 'existing' | 'new'
  device?: string
}
