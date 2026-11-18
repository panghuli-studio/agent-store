// GitHub's OAuth device flow and the few REST calls that find or create the backup
// repository (docs/backup-sync.md, "Connecting with GitHub"). No client secret: the
// device flow does not use one. The token is never put in an error message.
import type { GitHubBackupRepo, GitHubDeviceCode } from '@as/types'
import { FORMAT_FILE } from './layout'

/** The only scope requested: an OAuth app needs `repo` to create a private repository and push to it. */
export const GITHUB_SCOPE = 'repo'
/**
 * Asked for only by the extra sign-in that deletes the repository (docs/backup-sync.md, "Disconnecting").
 * `repo` comes with it so the token can see the private repository it deletes.
 */
export const GITHUB_DELETE_SCOPE = 'delete_repo'

/** The repository name tried first; `-2`, `-3`… follow when it is taken by something else. */
export const BACKUP_REPO_NAME = 'agent-store-backup'
const MAX_NAMES = 10

const TIMEOUT_MS = 15_000
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export interface GitHubOptions {
  /** Client id of the OAuth app with device flow enabled; empty means GitHub sign-in is not available. */
  clientId?: string
  /** https://github.com by default: the device-flow endpoints and the Git remotes. */
  webUrl?: string
  /** https://api.github.com by default. */
  apiUrl?: string
  fetchImpl?: FetchLike
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type GitHubErrorReason = 'github-not-configured' | 'github-signin-needed' | 'github-failed' | 'network'

export class BackupGitHubError extends Error {
  constructor(message: string, readonly reason: GitHubErrorReason) {
    super(message)
    this.name = 'BackupGitHubError'
  }
}

export type TokenPoll =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; token: string }

/** What the account holds: a backup to offer, and the name a new private repository gets. */
export interface Survey {
  existing: GitHubBackupRepo | null
  create: { name: string; exists: boolean }
}

interface RepoJson {
  full_name: string
  private: boolean
  html_url: string
  owner?: { login?: string }
}

const trim = (url: string) => url.replace(/\/+$/, '')

export class GitHubClient {
  readonly webUrl: string
  private readonly apiUrl: string
  private readonly clientId: string
  private readonly fetchImpl: FetchLike

  constructor(options: GitHubOptions = {}) {
    this.clientId = options.clientId?.trim() ?? ''
    this.webUrl = trim(options.webUrl || 'https://github.com')
    this.apiUrl = trim(options.apiUrl || 'https://api.github.com')
    // The global fetch is looked up per call, so tests that replace it are seen.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  private requireClientId(): string {
    if (!this.clientId) {
      throw new BackupGitHubError('GitHub sign-in is not set up in this build of Agent Store; connect with a Git URL instead', 'github-not-configured')
    }
    return this.clientId
  }

  private async request(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      throw new BackupGitHubError(`GitHub could not be reached while ${what} (${e instanceof Error ? e.message : String(e)})`, 'network')
    }
  }

  private async form(path: string, body: Record<string, string>, what: string): Promise<Record<string, unknown>> {
    const res = await this.request(`${this.webUrl}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }, what)
    let json: Record<string, unknown> | undefined
    try { json = (await res.json()) as Record<string, unknown> } catch { /* reported below */ }
    if (!json || typeof json !== 'object') throw new BackupGitHubError(`GitHub answered ${res.status} while ${what}`, 'github-failed')
    return json
  }

  /** `purpose: 'delete'` asks for `repo delete_repo` instead of `repo`. */
  async startDeviceFlow(purpose: 'connect' | 'delete' = 'connect'): Promise<GitHubDeviceCode> {
    const scope = purpose === 'delete' ? `${GITHUB_SCOPE} ${GITHUB_DELETE_SCOPE}` : GITHUB_SCOPE
    const json = await this.form('/login/device/code', { client_id: this.requireClientId(), scope }, 'starting the sign-in')
    if (typeof json['error'] === 'string') throw this.flowError(json)
    const { device_code, user_code, verification_uri, expires_in, interval } = json
    if (typeof device_code !== 'string' || typeof user_code !== 'string' || typeof verification_uri !== 'string') {
      throw new BackupGitHubError('GitHub did not return a device code', 'github-failed')
    }
    return {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      expiresIn: typeof expires_in === 'number' ? expires_in : 900,
      interval: typeof interval === 'number' ? interval : 5,
    }
  }

  /** `purpose: 'delete'` also requires `delete_repo` in the granted scopes. */
  async pollToken(deviceCode: string, purpose: 'connect' | 'delete' = 'connect'): Promise<TokenPoll> {
    const json = await this.form('/login/oauth/access_token', {
      client_id: this.requireClientId(), device_code: deviceCode, grant_type: DEVICE_GRANT,
    }, 'waiting for the sign-in')
    const error = json['error']
    if (error === 'authorization_pending') return { status: 'pending' }
    if (error === 'slow_down') return { status: 'slow_down', interval: typeof json['interval'] === 'number' ? json['interval'] : 10 }
    if (error === 'access_denied') return { status: 'denied' }
    if (error === 'expired_token' || error === 'incorrect_device_code') return { status: 'expired' }
    if (typeof error === 'string') throw this.flowError(json)
    const token = json['access_token']
    if (typeof token !== 'string' || !token) throw new BackupGitHubError('GitHub approved the sign-in but returned no token', 'github-failed')
    const scopes = typeof json['scope'] === 'string' ? json['scope'].split(/[ ,]+/) : [GITHUB_SCOPE]
    if (!scopes.includes(GITHUB_SCOPE)) {
      throw new BackupGitHubError(`The sign-in was approved without the "${GITHUB_SCOPE}" scope, which creating a private repository needs; sign in again and keep it`, 'github-signin-needed')
    }
    if (purpose === 'delete' && !scopes.includes(GITHUB_DELETE_SCOPE)) {
      // Not kept, so revoked at once: a token nobody holds should not stay valid.
      await this.revoke([token]).catch(() => undefined)
      throw new BackupGitHubError(`The sign-in was approved without the "${GITHUB_DELETE_SCOPE}" scope, which deleting the repository needs; sign in again and keep it`, 'github-signin-needed')
    }
    return { status: 'approved', token }
  }

  private flowError(json: Record<string, unknown>): BackupGitHubError {
    const code = String(json['error'])
    const description = typeof json['error_description'] === 'string' ? `: ${json['error_description']}` : ''
    const reason: GitHubErrorReason = code === 'device_flow_disabled' || code === 'incorrect_client_credentials' ? 'github-not-configured' : 'github-failed'
    return new BackupGitHubError(`GitHub refused the sign-in (${code}${description})`, reason)
  }

  private async api(token: string, method: string, path: string, what: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.request(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, what)
    let json: unknown = null
    try { json = await res.json() } catch { /* some answers have no body */ }
    if (res.status === 401) throw new BackupGitHubError(`GitHub no longer accepts this sign-in while ${what}; sign in again`, 'github-signin-needed')
    return { status: res.status, json }
  }

  private failed(what: string, r: { status: number; json: unknown }): BackupGitHubError {
    const message = (r.json as { message?: unknown } | null)?.message
    return new BackupGitHubError(`GitHub answered ${r.status} while ${what}${typeof message === 'string' ? ` (${message})` : ''}`, 'github-failed')
  }

  async login(token: string): Promise<string> {
    const r = await this.api(token, 'GET', '/user', 'reading the account')
    const login = (r.json as { login?: unknown } | null)?.login
    if (r.status !== 200 || typeof login !== 'string') throw this.failed('reading the account', r)
    return login
  }

  /** Walks `agent-store-backup`, `-2`… up to the first free name. */
  async survey(token: string, owner: string): Promise<Survey> {
    let existing: GitHubBackupRepo | null = null
    let create: Survey['create'] | null = null
    for (let n = 1; n <= MAX_NAMES && !(existing && create); n++) {
      const name = n === 1 ? BACKUP_REPO_NAME : `${BACKUP_REPO_NAME}-${n}`
      const what = `looking for ${owner}/${name}`
      const r = await this.api(token, 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, what)
      if (r.status === 404) {
        create ??= { name, exists: false }
        break
      }
      if (r.status !== 200) throw this.failed(what, r)
      const repo = toRepo(r.json as RepoJson)
      if (await this.isEmpty(token, repo.fullName)) {
        if (repo.private) create ??= { name, exists: true }
        continue
      }
      if (!existing && (await this.isBackup(token, repo.fullName))) existing = repo
    }
    if (!create) throw new BackupGitHubError(`${owner}/${BACKUP_REPO_NAME} and the next ${MAX_NAMES - 1} names are all taken; create a private repository yourself and connect with its URL`, 'github-failed')
    return { existing, create }
  }

  private async isEmpty(token: string, fullName: string): Promise<boolean> {
    const what = `reading ${fullName}`
    const r = await this.api(token, 'GET', `/repos/${fullName}/branches?per_page=1`, what)
    if (r.status !== 200) throw this.failed(what, r)
    return Array.isArray(r.json) && r.json.length === 0
  }

  /** Holds the format file at the root of its default branch. */
  private async isBackup(token: string, fullName: string): Promise<boolean> {
    const what = `reading ${fullName}`
    const r = await this.api(token, 'GET', `/repos/${fullName}/contents/${FORMAT_FILE}`, what)
    if (r.status === 404) return false
    if (r.status !== 200) throw this.failed(what, r)
    return true
  }

  async createPrivate(token: string, name: string): Promise<GitHubBackupRepo> {
    const what = `creating the private repository ${name}`
    const r = await this.api(token, 'POST', '/user/repos', what, {
      name,
      private: true,
      description: 'Agent Store backup: skills, MCP servers and providers, without keys',
      has_issues: false,
      has_projects: false,
      has_wiki: false,
      auto_init: false,
    })
    if (r.status !== 201) throw this.failed(what, r)
    return toRepo(r.json as RepoJson)
  }

  /**
   * Revokes the tokens through GitHub's credential revocation endpoint, which takes no authentication
   * and so no client secret (revoking the whole grant would need one). GitHub notifies the owner by email.
   */
  async revoke(tokens: string[]): Promise<void> {
    if (!tokens.length) return
    const what = 'revoking the GitHub token'
    const res = await this.request(`${this.apiUrl}/credentials/revoke`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ credentials: tokens }),
    }, what)
    let json: unknown = null
    try { json = await res.json() } catch { /* some answers have no body */ }
    if (res.status !== 202 && res.status !== 200 && res.status !== 204) throw this.failed(what, { status: res.status, json })
  }

  /** Deletes `owner/name`; `gone` when it no longer exists. The token needs `delete_repo`. */
  async deleteRepo(token: string, fullName: string): Promise<'deleted' | 'gone'> {
    const what = `deleting the repository ${fullName}`
    const [owner, name] = fullName.split('/')
    const r = await this.api(token, 'DELETE', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, what)
    if (r.status === 204) return 'deleted'
    if (r.status === 404) return 'gone'
    throw this.failed(what, r)
  }

  /** The page listing Agent Store among the user's authorized OAuth apps; undefined without a client id. */
  authorizationsUrl(): string | undefined {
    return this.clientId ? `${this.webUrl}/settings/connections/applications/${encodeURIComponent(this.clientId)}` : undefined
  }

  /** `owner/name` of a remote made by remoteOf on this GitHub, else undefined. */
  repoOf(remote: string): string | undefined {
    const prefix = `${this.webUrl}/`
    if (!remote.startsWith(prefix) || !remote.endsWith('.git')) return undefined
    const full = remote.slice(prefix.length, -'.git'.length)
    return /^[^/]+\/[^/]+$/.test(full) ? full : undefined
  }

  /** The HTTPS remote for `owner/name` on this GitHub. */
  remoteOf(fullName: string): string {
    return `${this.webUrl}/${fullName}.git`
  }
}

function toRepo(j: RepoJson): GitHubBackupRepo {
  return { fullName: j.full_name, private: j.private === true, url: j.html_url }
}
