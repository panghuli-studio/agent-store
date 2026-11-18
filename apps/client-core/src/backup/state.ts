// ~/.agent-store/backup/: the bare repository and what this device remembers about it.
// None of it is uploaded; credentials.json holds the token and is 0600.
import { mkdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import type { BackupConflict, BackupFailure, BackupItemRef, ToolTarget } from '@as/types'
import { atomicWriteFile, atomicWriteSecretFile } from '../config/safe-file'
import type { GitCredentials } from './git'

export interface Connection {
  remote: string
  branch: string
  device: string
  connectedAt: string
  /** Set when the connection was made by signing in with GitHub; `repo` (`owner/name`) since #233. */
  github?: { login: string; repo?: string }
}

/** An approved sign-in with `delete_repo`, waiting for disconnectBackup({ level: 'delete' }); 0600. */
export interface GitHubDeleteSignIn {
  token: string
  login: string
  approvedAt: string
}

/** An approved GitHub sign-in waiting for connectGitHubBackup; 0600, removed once connected or cancelled. */
export interface GitHubSignIn {
  token: string
  login: string
  /** The backup offered for connecting, `owner/name`. */
  existing: string | null
  approvedAt: string
}

/** A target the backup wants enabled that could not be enabled here. */
export interface BlockedTarget extends BackupItemRef {
  target: ToolTarget
  reason: 'no-key' | 'needs-config' | 'error'
  message: string
}

export interface SyncState {
  lastSync?: { commit: string; at: string }
  conflicts: BackupConflict[]
  blocked: BlockedTarget[]
  failed: BackupFailure[]
  notRestorable: BackupItemRef[]
}

export const backupDir = (aasHome: string) => join(aasHome, 'backup')
export const gitDirOf = (aasHome: string) => join(backupDir(aasHome), 'repo.git')
const connectionPath = (aasHome: string) => join(backupDir(aasHome), 'connection.json')
const credentialsPath = (aasHome: string) => join(backupDir(aasHome), 'credentials.json')
const signInPath = (aasHome: string) => join(backupDir(aasHome), 'github-signin.json')
const deleteSignInPath = (aasHome: string) => join(backupDir(aasHome), 'github-delete.json')
const statePath = (aasHome: string) => join(backupDir(aasHome), 'state.json')
export const lockTarget = (aasHome: string) => join(aasHome, 'backup')
export const lockPath = (aasHome: string) => join(aasHome, 'backup.lock')

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`${path} could not be read (${(e as Error).message}); run aas backup disconnect and connect again`)
  }
}

export const readConnection = (aasHome: string) => readJson<Connection>(connectionPath(aasHome))
export const readCredentials = (aasHome: string) => readJson<GitCredentials>(credentialsPath(aasHome))

export async function readState(aasHome: string): Promise<SyncState> {
  const s = await readJson<Partial<SyncState>>(statePath(aasHome))
  return {
    ...(s?.lastSync ? { lastSync: s.lastSync } : {}),
    conflicts: s?.conflicts ?? [],
    blocked: s?.blocked ?? [],
    failed: s?.failed ?? [],
    notRestorable: s?.notRestorable ?? [],
  }
}

export async function writeConnection(aasHome: string, c: Connection): Promise<void> {
  await mkdir(backupDir(aasHome), { recursive: true, mode: 0o700 })
  await atomicWriteFile(connectionPath(aasHome), JSON.stringify(c, null, 2) + '\n')
}

export async function writeCredentials(aasHome: string, c: GitCredentials): Promise<void> {
  await mkdir(backupDir(aasHome), { recursive: true, mode: 0o700 })
  await atomicWriteSecretFile(credentialsPath(aasHome), JSON.stringify(c))
}

export const readGitHubSignIn = (aasHome: string) => readJson<GitHubSignIn>(signInPath(aasHome))

export async function writeGitHubSignIn(aasHome: string, s: GitHubSignIn): Promise<void> {
  await mkdir(backupDir(aasHome), { recursive: true, mode: 0o700 })
  await atomicWriteSecretFile(signInPath(aasHome), JSON.stringify(s))
}

export async function deleteGitHubSignIn(aasHome: string): Promise<void> {
  await rm(signInPath(aasHome), { force: true })
}

export const readGitHubDeleteSignIn = (aasHome: string) => readJson<GitHubDeleteSignIn>(deleteSignInPath(aasHome))

export async function writeGitHubDeleteSignIn(aasHome: string, s: GitHubDeleteSignIn): Promise<void> {
  await atomicWriteSecretFile(deleteSignInPath(aasHome), JSON.stringify(s))
}

export async function deleteGitHubDeleteSignIn(aasHome: string): Promise<void> {
  await rm(deleteSignInPath(aasHome), { force: true })
}

export async function writeState(aasHome: string, s: SyncState): Promise<void> {
  await atomicWriteFile(statePath(aasHome), JSON.stringify(s, null, 2) + '\n')
}
