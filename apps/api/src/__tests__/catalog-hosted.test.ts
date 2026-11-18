import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { HostedSkillResourceDetail } from '@as/types'
import { openCatalogForWrite } from '../catalog/db'
import { decodeDetail, encodeDetail } from '../catalog/detail-codec'
import { linkResources, openDiscoveryForWrite, pickHosted } from '../catalog/discovery'
import { CatalogReader } from '../catalog/reader'
import { checkFiles, hostedSkillsSource, readHostedSkill, safeRelPath } from '../catalog/sources/hosted-skills'
import { syncCatalog } from '../catalog/sync'
import type { HostedCandidate, SourceContext } from '../catalog/types'
import { fakeFetch, json, octokitWith, type Route } from './helpers/upstream-fixtures'

const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')
const SKILL_MD = '---\nname: terraform\ndescription: Writes and reviews Terraform.\ntags: [iac]\n---\n\n# Terraform\n'
const GUIDE = '# Guide\n'

interface Fake {
  skillMd?: string
  /** What the file list says SKILL.md hashes to; defaults to the real hash. */
  listedSha?: string
  files?: unknown
  moderation?: Record<string, unknown>
  security?: string
  status?: number
  source?: string
  upstreamUrl?: string | null
  reports?: Record<string, { status: string }>
}

const fileList = (o: Fake) =>
  o.files ?? [
    { path: 'SKILL.md', size: Buffer.byteLength(o.skillMd ?? SKILL_MD), sha256: o.listedSha ?? sha(o.skillMd ?? SKILL_MD) },
    { path: 'guide.md', size: GUIDE.length, sha256: sha(GUIDE) },
  ]

/** ClawHub's skill, version and file endpoints for ivangdavila/terraform@1.0.4. */
function clawhub(o: Fake = {}): Route {
  return (url) => {
    if (url.hostname !== 'clawhub.ai') return undefined
    if (o.status) return new Response('error', { status: o.status })
    if (url.searchParams.get('ownerHandle') !== 'ivangdavila') return new Response('Not found', { status: 404 })
    if (url.pathname === '/api/v1/skills/terraform') {
      return json({
        skill: { slug: 'terraform', displayName: 'Terraform' },
        latestVersion: { version: '1.0.4', createdAt: 1785069145232 },
        owner: { handle: 'ivangdavila', displayName: 'Iván' },
        ...(o.moderation ? { moderation: o.moderation } : {}),
      })
    }
    if (url.pathname === '/api/v1/skills/terraform/versions/1.0.4') {
      return json({ version: { version: '1.0.4', files: fileList(o), security: { status: o.security ?? 'clean' } } })
    }
    if (url.pathname === '/api/v1/skills/terraform/file' && url.searchParams.get('version') === '1.0.4') {
      const path = url.searchParams.get('path')
      if (path === 'SKILL.md') return new Response(o.skillMd ?? SKILL_MD)
      if (path === 'guide.md') return new Response(GUIDE)
    }
    return new Response('Not found', { status: 404 })
  }
}

/** SkillHub's skill, files and file endpoints for @ake/dev-god@1.2.4. */
function skillhub(o: Fake = {}): Route {
  return (url) => {
    if (url.hostname !== 'api.skillhub.cn') return undefined
    if (url.pathname === '/api/v1/skills/dev-god') {
      return json({
        slug: 'dev-god',
        latestVersion: { version: '1.2.4', createdAt: 1791402289536 },
        namespace: { canonicalName: '@ake/dev-god', displayName: 'ake' },
        owner: { displayName: 'ake' },
        securityReports: o.reports ?? { keen: { status: 'benign' }, sanbu: { status: 'benign' } },
        skill: { slug: 'dev-god', displayName: '编程大神', source: o.source ?? 'enterprise', upstream_url: o.upstreamUrl ?? null, sourceUrl: null },
      })
    }
    if (url.pathname === '/api/v1/skills/dev-god/files' && url.searchParams.get('version') === '1.2.4') {
      return json({ count: 2, version: '1.2.4', files: fileList(o) })
    }
    if (url.pathname === '/api/v1/skills/dev-god/file' && url.searchParams.get('version') === '1.2.4') {
      const path = url.searchParams.get('path')
      if (path === 'SKILL.md') return new Response(o.skillMd ?? SKILL_MD)
      if (path === 'guide.md') return new Response(GUIDE)
    }
    return new Response('Not found', { status: 404 })
  }
}

const CLAW: HostedCandidate = { site: 'clawhub', listingId: 'ivangdavila/terraform', installs: 123 }
const HUB: HostedCandidate = { site: 'skillhub', listingId: '@ake/dev-god', installs: null }

const ctx = (f: typeof fetch, hosted?: HostedCandidate[], knownScopes: string[] = []): SourceContext => ({
  fetch: f, github: octokitWith(f), now: new Date(), full: false, state: { watermark: null, knownScopes }, log: () => {},
  ...(hosted ? { hosted } : {}),
})

describe('readHostedSkill', () => {
  test('a ClawHub skill: pinned to its version, every file with its SHA-256 and the canonical listing', async () => {
    const r = await readHostedSkill(fakeFetch(clawhub()), 'clawhub', CLAW)
    expect(r).toMatchObject({
      kind: 'skill', site: 'clawhub', upstreamId: 'ivangdavila/terraform', name: 'Terraform', description: 'Writes and reviews Terraform.',
      author: { name: 'Iván', url: null }, version: '1.0.4', homepageUrl: 'https://clawhub.ai/ivangdavila/skills/terraform',
      sourceUrl: 'https://clawhub.ai/ivangdavila/skills/terraform', installs: 123, tags: ['iac'], scope: 'ivangdavila/terraform',
      upstreamUpdatedAt: new Date(1785069145232).toISOString(),
    })
    const d = r.detail as Omit<HostedSkillResourceDetail, 'id'>
    expect(d.hosted).toEqual({
      site: 'clawhub', listingId: 'ivangdavila/terraform', slug: 'terraform', owner: 'ivangdavila', version: '1.0.4',
      url: 'https://clawhub.ai/ivangdavila/skills/terraform',
    })
    expect(d.files).toEqual([
      { path: 'SKILL.md', size: Buffer.byteLength(SKILL_MD), sha256: sha(SKILL_MD), downloadUrl: 'https://clawhub.ai/api/v1/skills/terraform/file?ownerHandle=ivangdavila&version=1.0.4&path=SKILL.md' },
      { path: 'guide.md', size: GUIDE.length, sha256: sha(GUIDE), downloadUrl: 'https://clawhub.ai/api/v1/skills/terraform/file?ownerHandle=ivangdavila&version=1.0.4&path=guide.md' },
    ])
  })

  test('a SkillHub skill: keyed by namespace, linked to skillhub.cn/skills/<slug>', async () => {
    const r = await readHostedSkill(fakeFetch(skillhub()), 'skillhub', HUB)
    expect(r).toMatchObject({ site: 'skillhub', upstreamId: 'ake/dev-god', name: '编程大神', version: '1.2.4', homepageUrl: 'https://skillhub.cn/skills/dev-god', installs: null })
    const d = r.detail as Omit<HostedSkillResourceDetail, 'id'>
    expect(d.hosted).toMatchObject({ site: 'skillhub', listingId: 'ake/dev-god', slug: 'dev-god', owner: null })
    expect(d.files[0]!.downloadUrl).toBe('https://api.skillhub.cn/api/v1/skills/dev-god/file?version=1.2.4&path=SKILL.md')
  })

  const excluded: Array<[string, Route, HostedCandidate, string]> = [
    ['SKILL.md without frontmatter', clawhub({ skillMd: '# Terraform Wrap\n\nNo frontmatter.\n' }), CLAW, 'frontmatter'],
    ['SKILL.md that does not match its SHA-256', clawhub({ listedSha: 'a'.repeat(64) }), CLAW, 'SHA-256'],
    ['no files (a GitHub handoff)', clawhub({ files: [] }), CLAW, 'no files'],
    ['a file without a SHA-256', clawhub({ files: [{ path: 'SKILL.md', size: 3 }] }), CLAW, 'SHA-256'],
    ['an unsafe path', clawhub({ files: [{ path: '../x', size: 1, sha256: sha('x') }] }), CLAW, 'unsafe'],
    ['flagged by moderation', clawhub({ moderation: { isMalwareBlocked: true } }), CLAW, 'flagged'],
    ['a malicious scan', clawhub({ security: 'malicious' }), CLAW, 'flagged'],
    ['gone upstream', clawhub(), { ...CLAW, listingId: 'someone/terraform' }, 'not found'],
    ['a SkillHub mirror of ClawHub', skillhub({ source: 'clawhub' }), HUB, 'mirror'],
    ['a SkillHub skill kept on GitHub', skillhub({ upstreamUrl: 'https://github.com/a/b' }), HUB, 'GitHub'],
    ['a SkillHub scan that is not benign', skillhub({ reports: { keen: { status: 'risky' } } }), HUB, 'scans'],
  ]
  for (const [what, route, c, reason] of excluded) {
    test(`left out: ${what}`, async () => {
      const run = await hostedSkillsSource(c.site).run(ctx(fakeFetch(route), [c]))
      expect(run.records).toEqual([])
      expect(run.errors).toEqual([])
      expect(Object.keys(run.skipped).join(' ')).toContain(reason)
      // Reconciled: a row an earlier run wrote goes unavailable.
      expect(run.coverage).toEqual({ mode: 'scoped', scopes: [c.listingId.replace(/^@/, '')] })
      expect(run.hostedChecks![0]!.status).toStartWith('excluded: ')
    })
  }

  test('an upstream failure keeps the previous state; a rate limit stops the run', async () => {
    const failing = await hostedSkillsSource('clawhub').run(ctx(fakeFetch(clawhub({ status: 503 })), [CLAW]))
    expect(failing.coverage).toEqual({ mode: 'scoped', scopes: [] })
    expect(failing.errors).toHaveLength(1)
    expect(failing.hostedChecks).toEqual([{ site: 'clawhub', listingId: 'ivangdavila/terraform', status: 'error', version: null }])

    const limited = await hostedSkillsSource('clawhub', { concurrency: 1 }).run(ctx(fakeFetch(clawhub({ status: 429 })), [CLAW, { ...CLAW, listingId: 'ivangdavila/other' }]))
    expect(limited.coverage).toEqual({ mode: 'scoped', scopes: [] })
    expect(limited.hostedChecks).toEqual([])
    expect(limited.skipped).toEqual({ 'not read: clawhub rate limit': 2 })
  })

  test('each source reads only its own site; without discovery it rechecks what the catalog holds', async () => {
    const run = await hostedSkillsSource('skillhub').run(ctx(fakeFetch(skillhub()), [CLAW, HUB]))
    expect(run.records.map((r) => r.upstreamId)).toEqual(['ake/dev-god'])
    const recheck = await hostedSkillsSource('clawhub').run(ctx(fakeFetch(clawhub()), undefined, ['ivangdavila/terraform']))
    expect(recheck.records.map((r) => r.upstreamId)).toEqual(['ivangdavila/terraform'])
  })
})

describe('checkFiles and paths', () => {
  test('relative paths only', () => {
    for (const ok of ['SKILL.md', 'a/b.md', '.hidden/x']) expect(safeRelPath(ok)).toBe(true)
    for (const bad of ['', '/etc/passwd', 'a/../b', './a', 'a//b', 'a\\b', 'a/\u0000']) expect(safeRelPath(bad)).toBe(false)
  })

  test('case-insensitive duplicates, a file that is also a directory and missing SKILL.md are refused', () => {
    const f = (path: string) => ({ path, size: 1, sha256: sha(path) })
    expect(() => checkFiles([f('SKILL.md'), f('skill.md')])).toThrow('duplicate')
    expect(() => checkFiles([f('SKILL.md'), f('a'), f('a/b')])).toThrow('directory')
    expect(() => checkFiles([f('README.md')])).toThrow('no SKILL.md')
    expect(checkFiles([f('SKILL.md'), { ...f('x'), sha256: sha('x').toUpperCase() }])[1]!.sha256).toBe(sha('x'))
  })
})

describe('detail codec', () => {
  test('download URLs are left out of catalog.db and rebuilt on read', async () => {
    const r = await readHostedSkill(fakeFetch(clawhub()), 'clawhub', CLAW)
    const stored = encodeDetail('skill', r.detail)
    expect(stored).not.toContain('downloadUrl')
    expect(decodeDetail('skill', stored)).toEqual(r.detail)
  })
})

describe('sync into the catalog', () => {
  let dir: string
  let db: Database
  let disc: Database
  let clock = Date.parse('2026-11-18T00:00:00Z')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'catalog-hosted-'))
    db = openCatalogForWrite(join(dir, 'catalog.db'))
    disc = openDiscoveryForWrite(join(dir, 'discovery.db'))
  })
  afterEach(() => {
    db.close()
    disc.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const addListing = (source: string, listingId: string, skillKey: string, opts: { repo?: string; downloads?: number; installs?: number; version?: string } = {}) =>
    disc.query(`INSERT INTO listings (source, listing_id, skill_key, name, url, github_repo, version, metrics, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 't', 't')`).run(
      source, listingId, skillKey, listingId, `https://example.com/${listingId}`, opts.repo ?? null, opts.version ?? null,
      JSON.stringify({ ...(opts.downloads !== undefined ? { downloads_total: opts.downloads } : {}), ...(opts.installs !== undefined ? { installs_reported: opts.installs } : {}) }),
    )

  test('pickHosted: only the site\'s own skills with no GitHub repo anywhere, most downloaded first', () => {
    addListing('clawhub', 'a/one', 'clawhub:a/one', { downloads: 10 })
    addListing('clawhub', 'a/two', 'clawhub:a/two', { downloads: 50, installs: 7 })
    addListing('clawhub', 'a/gh', 'clawhub:a/gh', { downloads: 99 })
    addListing('skillhub', '@m/gh', 'clawhub:a/gh', { repo: 'a/gh' })
    // A SkillHub mirror of ClawHub is keyed to ClawHub: not SkillHub's own.
    addListing('skillhub', '@clawhub_a/one', 'clawhub:a/one', { downloads: 5 })
    addListing('skillhub', '@ns/own', 'skillhub:ns/own', { downloads: 1 })
    const claw = pickHosted(disc, 'clawhub', 10)
    expect(claw.candidates).toEqual([
      { site: 'clawhub', listingId: 'a/two', installs: 7 },
      { site: 'clawhub', listingId: 'a/one', installs: null },
    ])
    expect(pickHosted(disc, 'skillhub', 10).candidates.map((c) => c.listingId)).toEqual(['@ns/own'])
    expect(pickHosted(disc, 'clawhub', 1).report).toMatchObject({ pickedNew: 1, waitingNew: 1 })
  })

  test('checked skills reach /api/resources; a changed version is read again, a rejected one goes unavailable', async () => {
    addListing('clawhub', 'ivangdavila/terraform', 'clawhub:ivangdavila/terraform', { downloads: 4925, installs: 123, version: '1.0.4' })
    addListing('skillhub', '@ake/dev-god', 'skillhub:ake/dev-god', { downloads: 11460606, version: '1.2.4' })
    addListing('skillhub', '@user_922b1001/terraform-wrap', 'skillhub:user_922b1001/terraform-wrap', { downloads: 810 })
    const sync = (...routes: Route[]) => {
      const f = fakeFetch(...routes, (url) => (url.hostname === 'api.skillhub.cn' ? new Response('Not found', { status: 404 }) : undefined))
      return syncCatalog(db, {
        sources: [hostedSkillsSource('clawhub'), hostedSkillsSource('skillhub')],
        fetch: f, github: octokitWith(f),
        discovery: { db: disc, sources: [], httpRetries: 0 },
        now: () => new Date((clock += 1000)),
      })
    }
    const first = await sync(clawhub(), skillhub())
    expect(first.sources.map((s) => [s.source, s.added])).toEqual([['clawhub-skills', 1], ['skillhub-skills', 1]])
    expect(first.discovery!.hostedQueue).toMatchObject({ clawhub: { pickedNew: 1 }, skillhub: { pickedNew: 2 } })
    expect(first.discovery!.linkedResources).toBe(2)

    const path = join(dir, 'catalog.db')
    const reader = new CatalogReader()
    reader.open(path)
    try {
      expect(reader.list({ kind: 'skill' }).resources.map((r) => r.id).sort()).toEqual(['clawhub:ivangdavila/terraform', 'skillhub:ake/dev-god'])
      const d = reader.get('clawhub:ivangdavila/terraform') as HostedSkillResourceDetail
      expect(d.origin).toMatchObject({ site: 'clawhub', url: 'https://clawhub.ai/ivangdavila/skills/terraform' })
      expect(d.hosted.url).toBe('https://clawhub.ai/ivangdavila/skills/terraform')
      expect(d.files.every((f) => f.downloadUrl.startsWith('https://clawhub.ai/api/v1/skills/terraform/file?'))).toBe(true)
    } finally {
      reader.close()
    }
    const status = (id: string) => (disc.query('SELECT content_status, content_version FROM listings WHERE listing_id = ?').get(id) as { content_status: string; content_version: string | null })
    expect(status('ivangdavila/terraform')).toEqual({ content_status: 'ok', content_version: '1.0.4' })
    expect(status('@user_922b1001/terraform-wrap').content_status).toStartWith('excluded: ')

    // The site lists a new version: picked as changed. Its SKILL.md no longer parses, so the row goes.
    disc.query("UPDATE listings SET version = '1.0.5' WHERE listing_id = 'ivangdavila/terraform'").run()
    expect(pickHosted(disc, 'clawhub', 1).report).toMatchObject({ pickedChanged: 1 })
    const second = await sync(clawhub({ skillMd: '# no frontmatter\n' }), skillhub())
    expect(second.sources[0]).toMatchObject({ source: 'clawhub-skills', unavailable: 1 })
    expect((db.query("SELECT unavailable_at FROM resources WHERE id = 'clawhub:ivangdavila/terraform'").get() as { unavailable_at: string | null }).unavailable_at).not.toBeNull()
    expect(linkResources(disc, db)).toBe(2)
  })
})
