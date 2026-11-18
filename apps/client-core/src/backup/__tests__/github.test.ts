// GitHub sign-in for the backup against a fake GitHub: the device flow and REST calls are
// answered here, and the repositories it "creates" are local bare repositories.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Item, SkillItem } from '@as/types'
import { EngineImpl } from '../../engine'
import { ItemCatalog } from '../../__tests__/helpers/item-catalog'
import { runGit } from '../git'
import { BackupGitHubError } from '../github'

process.env['AS_CLAUDE_BIN'] = ''
process.env['AS_CODEX_BIN'] = ''

const TOKEN = 'gho_FAKEtoken0123456789abcdefABCDEF0123'
const API = 'https://api.gh.test'

let root: string
let web: string
const origHome = process.env['HOME']
const origFetch = globalThis.fetch

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'as-backup-gh-'))
  process.env['HOME'] = join(root, 'home')
  await mkdir(process.env['HOME'], { recursive: true })
  process.env['GIT_CONFIG_NOSYSTEM'] = '1'
})

afterAll(async () => {
  process.env['HOME'] = origHome
  await rm(root, { recursive: true, force: true })
})

afterEach(() => {
  globalThis.fetch = origFetch
})

const publisher = { id: 'p1', slug: 'pub', name: 'Pub', avatarUrl: '', tier: 'community' as const }
const skill: SkillItem = {
  id: 'i1', name: 'Notes', description: 'desc', version: '1.0.0', publisher, compatibleWith: ['claude', 'codex'], tags: [],
  downloads: 0, status: 'published', createdAt: '2026-06-18T00:00:00Z', updatedAt: '2026-06-18T00:00:00Z', installHook: { steps: [] },
  slug: 'notes', category: 'skill', contentUrl: 'https://s.test/notes/SKILL.md',
}
const ITEMS: Item[] = [skill]
const SKILL_MD = '---\nname: notes\ndescription: Take notes\n---\nBody\n'

type Grant = 'pending' | 'slow_down' | 'denied' | 'expired' | 'approved'

/** One GitHub account, `me`, and what the device flow answers next for each code. */
class FakeGitHub {
  grants: Grant[] = ['approved']
  scope = 'repo'
  repos = new Map<string, { private: boolean }>()
  calls: Array<{ url: string; method: string; auth?: string; body?: string }> = []
  failCreate = false
  private codes = 0

  path(fullName: string) {
    return join(web, `${fullName}.git`)
  }

  async addRepo(name: string, opts: { private?: boolean; content?: 'backup' | 'other' } = {}) {
    const full = `me/${name}`
    this.repos.set(full, { private: opts.private ?? true })
    await runGit(null, ['init', '--bare', '-q', '--initial-branch=main', this.path(full)])
    if (!opts.content) return
    const work = await mkdtemp(join(root, 'work-'))
    const file = opts.content === 'backup' ? 'agent-store-backup.json' : 'README.md'
    await writeFile(join(work, file), opts.content === 'backup' ? '{"format":"agent-store-backup","schema":1}' : '# hi\n')
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    await runGit(null, ['init', '-q', '--initial-branch=main', work])
    await runGit(null, ['-C', work, 'add', '.'])
    await runGit(null, ['-C', work, 'commit', '-q', '-m', 'init'], { env })
    await runGit(null, ['-C', work, 'push', '-q', this.path(full), 'main'])
  }

  private json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>
    this.calls.push({ url, method: init.method ?? 'GET', auth: headers['Authorization'], body: typeof init.body === 'string' ? init.body : undefined })
    if (url === `${web}/login/device/code`) {
      return this.json(200, { device_code: `dc-${++this.codes}`, user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
    }
    if (url === `${web}/login/oauth/access_token`) {
      const g = this.grants.length > 1 ? this.grants.shift()! : this.grants[0]
      if (g === 'approved') return this.json(200, { access_token: TOKEN, token_type: 'bearer', scope: this.scope })
      const error = { pending: 'authorization_pending', slow_down: 'slow_down', denied: 'access_denied', expired: 'expired_token' }[g]
      return this.json(200, { error, ...(g === 'slow_down' ? { interval: 10 } : {}) })
    }
    if (!url.startsWith(API)) throw new Error(`Unmocked URL: ${url}`)
    if (headers['Authorization'] !== `Bearer ${TOKEN}`) return this.json(401, { message: 'Bad credentials' })
    const path = url.slice(API.length)
    if (path === '/user') return this.json(200, { login: 'me' })
    if (path === '/user/repos' && init.method === 'POST') {
      if (this.failCreate) return this.json(500, { message: 'boom' })
      const body = JSON.parse(String(init.body)) as { name: string; private: boolean }
      await this.addRepo(body.name, { private: body.private })
      return this.json(201, { full_name: `me/${body.name}`, private: body.private, html_url: `https://github.com/me/${body.name}` })
    }
    let m = /^\/repos\/(me\/[^/?]+)$/.exec(path)
    if (m) {
      const r = this.repos.get(m[1])
      return r ? this.json(200, { full_name: m[1], private: r.private, html_url: `https://github.com/${m[1]}` }) : this.json(404, { message: 'Not Found' })
    }
    m = /^\/repos\/(me\/[^/?]+)\/branches\?per_page=1$/.exec(path)
    if (m) {
      const refs = (await runGit(this.path(m[1]), ['for-each-ref', '--format=%(refname)', 'refs/heads'])).trim()
      return this.json(200, refs ? [{ name: 'main' }] : [])
    }
    m = /^\/repos\/(me\/[^/?]+)\/contents\/agent-store-backup\.json$/.exec(path)
    if (m) {
      try {
        await runGit(this.path(m[1]), ['cat-file', '-e', 'main:agent-store-backup.json'])
        return this.json(200, { name: 'agent-store-backup.json' })
      } catch {
        return this.json(404, { message: 'Not Found' })
      }
    }
    throw new Error(`Unmocked API path: ${path}`)
  }
}

let counter = 0

async function device(gh: FakeGitHub, clientId = 'Iv1.test-client') {
  const dir = join(root, `device-${++counter}`)
  const aasHome = join(dir, 'agent-store')
  const claudeDir = join(dir, 'claude')
  const codexDir = join(dir, 'codex')
  for (const d of [aasHome, claudeDir, codexDir]) await mkdir(d, { recursive: true })
  const engine = new EngineImpl({ aasHome, claudeConfigDir: claudeDir, codexConfigDir: codexDir }, 'http://localhost:9', {
    catalog: new ItemCatalog(() => ITEMS),
    github: { clientId, webUrl: web, apiUrl: API, fetchImpl: gh.fetch },
  })
  return { aasHome, engine }
}

async function fresh(): Promise<FakeGitHub> {
  web = join(root, `gh-${++counter}`)
  await mkdir(join(web, 'me'), { recursive: true })
  globalThis.fetch = (async (url: string) => {
    if (String(url) === skill.contentUrl) return new Response(SKILL_MD, { status: 200 })
    throw new Error(`Unmocked URL: ${url}`)
  }) as typeof fetch
  return new FakeGitHub()
}

const signInFile = (aasHome: string) => join(aasHome, 'backup', 'github-signin.json')

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name))
  }
  return out
}

test('without a client id GitHub sign-in says it is not set up', async () => {
  const gh = await fresh()
  const { engine } = await device(gh, '')
  const err = await engine.startGitHubBackupSignIn().catch(e => e)
  expect(err).toBeInstanceOf(BackupGitHubError)
  expect(err.reason).toBe('github-not-configured')
  expect(gh.calls).toEqual([])
})

test('sign in, create the private repository, connect and back up; the token stays on this machine', async () => {
  const gh = await fresh()
  gh.grants = ['pending', 'slow_down', 'approved']
  const { aasHome, engine } = await device(gh)
  await engine.install('notes')

  const code = await engine.startGitHubBackupSignIn()
  expect(code).toMatchObject({ userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', interval: 5 })
  const start = gh.calls[0]
  expect(new URLSearchParams(start.body).get('scope')).toBe('repo')
  expect(await engine.pollGitHubBackupSignIn(code.deviceCode)).toEqual({ status: 'pending' })
  expect(await engine.pollGitHubBackupSignIn(code.deviceCode)).toEqual({ status: 'slow_down', interval: 10 })
  const approved = await engine.pollGitHubBackupSignIn(code.deviceCode)
  expect(approved).toEqual({ status: 'approved', login: 'me', existing: null, create: 'me/agent-store-backup' })
  expect(JSON.stringify(approved)).not.toContain(TOKEN)
  expect((await stat(signInFile(aasHome))).mode & 0o777).toBe(0o600)

  const r = await engine.connectGitHubBackup({ repo: 'new', device: 'laptop' })
  expect(gh.repos.get('me/agent-store-backup')).toEqual({ private: true })
  expect(r.remoteItems).toBe(0)
  expect(r.status).toMatchObject({ connected: true, remote: `${web}/me/agent-store-backup.git`, device: 'laptop', hasCredentials: true, github: { login: 'me' } })
  expect(existsSync(signInFile(aasHome))).toBe(false)
  const creds = join(aasHome, 'backup', 'credentials.json')
  expect(JSON.parse(await readFile(creds, 'utf-8'))).toEqual({ username: 'me', password: TOKEN })
  expect((await stat(creds)).mode & 0o777).toBe(0o600)

  const pushed = await engine.backupNow()
  expect(pushed.uploaded.map(u => u.key)).toEqual(['skill/notes'])
  // Neither the remote nor any other local file holds the token.
  for (const f of await filesUnder(gh.path('me/agent-store-backup'))) expect(await readFile(f, 'latin1')).not.toContain(TOKEN)
  for (const f of await filesUnder(aasHome)) {
    if (f !== creds) expect(await readFile(f, 'latin1')).not.toContain(TOKEN)
  }
  const tree = await runGit(gh.path('me/agent-store-backup'), ['ls-tree', '-r', '--name-only', 'main'])
  expect(tree).toContain('items/skill/notes/content/files/SKILL.md')
})

test('a second device is offered the existing backup, or creates the next name with new', async () => {
  const gh = await fresh()
  await gh.addRepo('agent-store-backup', { content: 'backup' })
  const a = await device(gh)
  const code = await a.engine.startGitHubBackupSignIn()
  const approved = await a.engine.pollGitHubBackupSignIn(code.deviceCode)
  expect(approved).toEqual({
    status: 'approved', login: 'me',
    existing: { fullName: 'me/agent-store-backup', private: true, url: 'https://github.com/me/agent-store-backup' },
    create: 'me/agent-store-backup-2',
  })
  const r = await a.engine.connectGitHubBackup({ repo: 'existing' })
  expect(r.status.remote).toBe(`${web}/me/agent-store-backup.git`)
  expect(gh.calls.some(c => c.method === 'POST' && c.url.endsWith('/user/repos'))).toBe(false)

  const b = await device(gh)
  await b.engine.pollGitHubBackupSignIn((await b.engine.startGitHubBackupSignIn()).deviceCode)
  const nr = await b.engine.connectGitHubBackup({ repo: 'new' })
  expect(nr.status.remote).toBe(`${web}/me/agent-store-backup-2.git`)
  expect(gh.repos.get('me/agent-store-backup-2')).toEqual({ private: true })
})

test('a name taken by something else is skipped; an empty private one is reused instead of created', async () => {
  const gh = await fresh()
  await gh.addRepo('agent-store-backup', { content: 'other' })
  await gh.addRepo('agent-store-backup-2', { private: false })
  await gh.addRepo('agent-store-backup-3')
  const { engine } = await device(gh)
  const approved = await engine.pollGitHubBackupSignIn((await engine.startGitHubBackupSignIn()).deviceCode)
  expect(approved).toMatchObject({ status: 'approved', existing: null, create: 'me/agent-store-backup-3' })
  const r = await engine.connectGitHubBackup({ repo: 'new' })
  expect(r.status.remote).toBe(`${web}/me/agent-store-backup-3.git`)
  expect(gh.calls.some(c => c.url.endsWith('/user/repos'))).toBe(false)
})

test('denied and expired sign-ins leave nothing behind; a cancelled one forgets the token', async () => {
  for (const grant of ['denied', 'expired'] as const) {
    const gh = await fresh()
    gh.grants = [grant]
    const { aasHome, engine } = await device(gh)
    expect(await engine.pollGitHubBackupSignIn((await engine.startGitHubBackupSignIn()).deviceCode)).toEqual({ status: grant })
    expect(existsSync(signInFile(aasHome))).toBe(false)
    const err = await engine.connectGitHubBackup({ repo: 'new' }).catch(e => e)
    expect(err.reason).toBe('github-signin-needed')
    expect((await engine.getBackupStatus()).connected).toBe(false)
  }

  const gh = await fresh()
  const { aasHome, engine } = await device(gh)
  await engine.pollGitHubBackupSignIn((await engine.startGitHubBackupSignIn()).deviceCode)
  expect(existsSync(signInFile(aasHome))).toBe(true)
  await engine.cancelGitHubBackupSignIn()
  expect(existsSync(signInFile(aasHome))).toBe(false)
  expect((await engine.connectGitHubBackup({ repo: 'new' }).catch(e => e)).reason).toBe('github-signin-needed')
  expect(gh.repos.size).toBe(0)
})

test('a failed connect keeps the sign-in for another try; a sign-in without the repo scope is refused', async () => {
  const gh = await fresh()
  gh.failCreate = true
  const { aasHome, engine } = await device(gh)
  await engine.pollGitHubBackupSignIn((await engine.startGitHubBackupSignIn()).deviceCode)
  const err = await engine.connectGitHubBackup({ repo: 'new' }).catch(e => e)
  expect(err.reason).toBe('github-failed')
  expect(String(err.message)).not.toContain(TOKEN)
  expect(existsSync(signInFile(aasHome))).toBe(true)
  gh.failCreate = false
  expect((await engine.connectGitHubBackup({ repo: 'new' })).status.connected).toBe(true)
  // Already connected: a new sign-in is refused before GitHub is asked.
  expect((await engine.startGitHubBackupSignIn().catch(e => e)).reason).toBe('already-connected')

  const narrow = await fresh()
  narrow.scope = 'public_repo'
  const d = await device(narrow)
  const e2 = await d.engine.pollGitHubBackupSignIn((await d.engine.startGitHubBackupSignIn()).deviceCode).catch(e => e)
  expect(e2.reason).toBe('github-signin-needed')
  expect(existsSync(signInFile(d.aasHome))).toBe(false)
})
