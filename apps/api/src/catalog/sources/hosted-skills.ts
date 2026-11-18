import type { HostedSkillFile, HostedSkillResourceDetail, ResourceSummary, SkillHostSite } from '@as/types'
import pMap from 'p-map'
import { getJson, isRecord, str, UpstreamError } from '../http'
import { addSkip, type CatalogRecord, type CatalogSource, type HostedCandidate, type HostedCheck, type SourceRun } from '../types'
import { githubRepoOf } from '../stars'
import { parseSkillMd } from './github-skills'
import { CLAWHUB_BASE, hostedFileUrl, hostedListingUrl, SKILLHUB_BASE } from '../detail-codec'

export { hostedFileUrl, hostedListingUrl }

// Skills ClawHub and SkillHub host themselves, with no GitHub repo behind them. Each
// is pinned to its latest published version; every file carries the SHA-256 and size
// the site published, and the client checks each download against both. Entries whose
// SKILL.md does not download, match or parse, or that list no files, are left out.
//
// ClawHub: GET /api/v1/skills/{slug}?ownerHandle=, …/versions/{version}?ownerHandle=
// (files with sha256), …/file?path=&version=&ownerHandle= (docs/http-api.md in
// openclaw/clawhub). SkillHub: GET /api/v1/skills/{slug}, …/files?version= (files with
// sha256), …/file?path=&version= (302 to the site's storage).

/** Over these a version is left out: the client refuses more files than this, and big skills are not instructions. */
export const MAX_HOSTED_FILES = 2000
export const MAX_HOSTED_BYTES = 50 * 1024 * 1024

const SHA256 = /^[0-9a-f]{64}$/
const enc = encodeURIComponent

/** A relative '/'-separated path with no empty, '.' or '..' segment, no backslash or control character. */
export function safeRelPath(path: string): boolean {
  if (!path || path.length > 1024 || path.startsWith('/') || /[\\\u0000-\u001f]/.test(path)) return false
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}

/** Site, slug and owner from a candidate's listing id (`owner/slug`, or SkillHub `namespace/slug`). */
export function parseListingId(site: SkillHostSite, listingId: string): { slug: string; owner: string | null } | null {
  const m = /^@?([^/\s]+)\/([^/\s]+)$/.exec(listingId)
  if (!m) return null
  return site === 'clawhub' ? { owner: m[1]!.toLowerCase(), slug: m[2]! } : { owner: null, slug: m[2]! }
}

/** Why an entry is left out; the entry is reconciled (an earlier row goes unavailable). */
class Excluded extends Error {}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

/** The files a site lists, checked; throws Excluded when any is malformed or the set is not a skill. */
export function checkFiles(raw: unknown): Array<Omit<HostedSkillFile, 'downloadUrl'>> {
  if (!Array.isArray(raw) || raw.length === 0) throw new Excluded('no files listed')
  if (raw.length > MAX_HOSTED_FILES) throw new Excluded('too many files')
  const seen = new Set<string>()
  let total = 0
  const files = raw.map((f) => {
    if (!isRecord(f)) throw new Excluded('malformed file entry')
    const path = str(f['path'])
    const digest = str(f['sha256'])?.toLowerCase() ?? null
    const size = f['size']
    if (!path || !safeRelPath(path)) throw new Excluded('unsafe file path')
    if (!digest || !SHA256.test(digest)) throw new Excluded('file without a SHA-256')
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) throw new Excluded('file without a size')
    // Two paths one case-insensitive disk would merge are one file too many.
    const key = path.toLowerCase()
    if (seen.has(key)) throw new Excluded('duplicate file path')
    seen.add(key)
    total += size
    return { path, size, sha256: digest }
  })
  if (total > MAX_HOSTED_BYTES) throw new Excluded('files too large')
  // A path that is also another path's directory cannot be written.
  for (const p of seen) {
    const i = p.lastIndexOf('/')
    for (let d = i > 0 ? p.slice(0, i) : ''; d; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
      if (seen.has(d)) throw new Excluded('file path clashes with a directory')
    }
  }
  if (!files.some((f) => f.path === 'SKILL.md')) throw new Excluded('no SKILL.md')
  return files
}

async function download(fetchImpl: typeof fetch, url: string, label: string): Promise<Uint8Array> {
  let res: Response
  try {
    res = await fetchImpl(url, { headers: { 'user-agent': 'agent-store-catalog-sync' }, signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    throw new UpstreamError('unavailable', `${label} unreachable: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 404 || res.status === 410) throw new Excluded(`${label}: HTTP ${res.status}`)
  if (res.status === 429) throw new UpstreamError('rate_limited', `${label}: HTTP 429`)
  if (!res.ok) throw new UpstreamError(res.status >= 500 ? 'unavailable' : 'bad_response', `${label}: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

interface Version {
  version: string
  publishedAt: string | null
  files: Array<Omit<HostedSkillFile, 'downloadUrl'>>
  displayName: string | null
  author: string | null
}

const isoOf = (ms: unknown) => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null)

/** 404 means the entry is gone: excluded, not an error. */
async function json(fetchImpl: typeof fetch, url: string, label: string): Promise<unknown> {
  try {
    return await getJson(fetchImpl, url, label, 30_000)
  } catch (e) {
    if (e instanceof UpstreamError && e.code === 'not_found') throw new Excluded(`${label}: not found`)
    throw e
  }
}

async function clawhubVersion(fetchImpl: typeof fetch, slug: string, owner: string): Promise<Version> {
  const q = `ownerHandle=${enc(owner)}`
  const body = await json(fetchImpl, `${CLAWHUB_BASE}/api/v1/skills/${enc(slug)}?${q}`, `clawhub ${owner}/${slug}`)
  if (!isRecord(body) || !isRecord(body['skill'])) throw new UpstreamError('bad_response', `clawhub ${owner}/${slug}: unexpected response shape`)
  const ownerOf = isRecord(body['owner']) ? body['owner'] : {}
  if (str(ownerOf['handle'])?.toLowerCase() !== owner) throw new Excluded('owner does not match the listing')
  const mod = isRecord(body['moderation']) ? body['moderation'] : {}
  if (mod['isMalwareBlocked'] === true || mod['isSuspicious'] === true) throw new Excluded('flagged by the site')
  const latest = isRecord(body['latestVersion']) ? body['latestVersion'] : {}
  const version = str(latest['version'])
  if (!version) throw new Excluded('no published version')
  const vbody = await json(fetchImpl, `${CLAWHUB_BASE}/api/v1/skills/${enc(slug)}/versions/${enc(version)}?${q}`, `clawhub ${owner}/${slug}@${version}`)
  const v = isRecord(vbody) && isRecord(vbody['version']) ? vbody['version'] : null
  if (!v) throw new UpstreamError('bad_response', `clawhub ${owner}/${slug}@${version}: unexpected response shape`)
  const security = isRecord(v['security']) ? str(v['security']['status']) : null
  if (security === 'malicious' || security === 'suspicious') throw new Excluded('flagged by the site')
  return {
    version,
    publishedAt: isoOf(latest['createdAt']) ?? isoOf(v['createdAt']),
    files: checkFiles(v['files']),
    displayName: str(body['skill']['displayName']),
    author: str(ownerOf['displayName']) ?? owner,
  }
}

async function skillhubVersion(fetchImpl: typeof fetch, slug: string, listingId: string): Promise<Version> {
  const body = await json(fetchImpl, `${SKILLHUB_BASE}/api/v1/skills/${enc(slug)}`, `skillhub ${slug}`)
  if (!isRecord(body) || !isRecord(body['skill'])) throw new UpstreamError('bad_response', `skillhub ${slug}: unexpected response shape`)
  const skill = body['skill']
  const ns = isRecord(body['namespace']) ? body['namespace'] : {}
  if (str(ns['canonicalName'])?.replace(/^@/, '').toLowerCase() !== listingId.replace(/^@/, '').toLowerCase()) {
    throw new Excluded('namespace does not match the listing')
  }
  // Mirrors of ClawHub and skills kept on GitHub are not SkillHub's own.
  if (skill['source'] === 'clawhub') throw new Excluded('mirror of another site')
  if (githubRepoOf(str(skill['upstream_url'])) || githubRepoOf(str(skill['sourceUrl']))) throw new Excluded('kept on GitHub')
  const reports = isRecord(body['securityReports']) ? Object.values(body['securityReports']) : []
  if (reports.some((r) => !isRecord(r) || r['status'] !== 'benign')) throw new Excluded('not cleared by the site\'s scans')
  const latest = isRecord(body['latestVersion']) ? body['latestVersion'] : {}
  const version = str(latest['version'])
  if (!version) throw new Excluded('no published version')
  const fbody = await json(fetchImpl, `${SKILLHUB_BASE}/api/v1/skills/${enc(slug)}/files?version=${enc(version)}`, `skillhub ${slug}@${version} files`)
  if (!isRecord(fbody)) throw new UpstreamError('bad_response', `skillhub ${slug}@${version} files: unexpected response shape`)
  if (str(fbody['version']) !== version) throw new Excluded('file list is for another version')
  const owner = isRecord(body['owner']) ? body['owner'] : {}
  return {
    version,
    publishedAt: isoOf(latest['createdAt']),
    files: checkFiles(fbody['files']),
    displayName: str(skill['displayName']),
    author: str(owner['displayName']) ?? str(ns['displayName']),
  }
}

/** One candidate: its record, or Excluded with the reason, or an upstream error (left for a later run). */
export async function readHostedSkill(fetchImpl: typeof fetch, site: SkillHostSite, c: HostedCandidate): Promise<CatalogRecord> {
  const ids = parseListingId(site, c.listingId)
  if (!ids) throw new Excluded('malformed listing id')
  const { slug, owner } = ids
  const v = site === 'clawhub' ? await clawhubVersion(fetchImpl, slug, owner!) : await skillhubVersion(fetchImpl, slug, c.listingId)
  const hosted: HostedSkillResourceDetail['hosted'] = {
    site,
    listingId: c.listingId.replace(/^@/, '').toLowerCase(),
    slug,
    owner,
    version: v.version,
    url: hostedListingUrl(site, slug, owner),
  }
  const skillMd = v.files.find((f) => f.path === 'SKILL.md')!
  const bytes = await download(fetchImpl, hostedFileUrl(hosted, 'SKILL.md'), `${site} ${hosted.listingId} SKILL.md`)
  if (bytes.length !== skillMd.size || sha256(bytes) !== skillMd.sha256) throw new Excluded('SKILL.md does not match its SHA-256')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Excluded('SKILL.md is not UTF-8')
  }
  const fm = parseSkillMd(text)
  const name = fm ? str(fm['name']) : null
  const description = fm ? str(fm['description']) : null
  if (!fm || !name || !description) throw new Excluded('SKILL.md frontmatter lacks name or description')

  const files: HostedSkillFile[] = v.files.map((f) => ({ ...f, downloadUrl: hostedFileUrl(hosted, f.path) }))
  const detail: Omit<HostedSkillResourceDetail, keyof ResourceSummary> = { hosted, frontmatter: fm, files }
  const tags = Array.isArray(fm['tags']) ? fm['tags'].filter((t): t is string => typeof t === 'string') : []
  return {
    kind: 'skill',
    site,
    upstreamId: hosted.listingId,
    name: v.displayName ?? name,
    description,
    author: v.author ? { name: v.author, url: null } : null,
    version: v.version,
    homepageUrl: hosted.url,
    installs: c.installs,
    verified: false,
    tags,
    transports: [],
    sourceUrl: hosted.url,
    upstreamVersion: v.version,
    upstreamUpdatedAt: v.publishedAt,
    scope: hosted.listingId,
    detail,
  }
}

/**
 * Reads the hosted skills of one site the sync picked from discovery.db (`ctx.hosted`).
 * Without discovery it rechecks the skills of this site the catalog already holds.
 * A skill read again without a usable version becomes unavailable; one that failed for
 * an upstream reason keeps its previous state.
 */
export function hostedSkillsSource(site: SkillHostSite, options: { concurrency?: number; maxRecheck?: number } = {}): CatalogSource {
  return {
    name: `${site}-skills`,
    site,
    kind: 'skill',
    async run(ctx): Promise<SourceRun> {
      const run: SourceRun = { records: [], removed: [], skipped: {}, errors: [], coverage: { mode: 'scoped', scopes: [] }, hostedChecks: [] }
      const candidates: HostedCandidate[] = ctx.hosted
        ? ctx.hosted.filter((c) => c.site === site)
        : ctx.state.knownScopes.slice(0, options.maxRecheck ?? 200).map((listingId) => ({ site, listingId, installs: null }))
      const scopes: string[] = []
      let rateLimited = false
      await pMap(
        candidates,
        async (c) => {
          const check: HostedCheck = { site, listingId: c.listingId, status: 'error', version: null }
          if (rateLimited) {
            addSkip(run.skipped, `not read: ${site} rate limit`)
            return
          }
          try {
            const record = await readHostedSkill(ctx.fetch, site, c)
            run.records.push(record)
            scopes.push(record.scope!)
            check.status = 'ok'
            check.version = record.upstreamVersion
          } catch (e) {
            if (e instanceof Excluded) {
              addSkip(run.skipped, e.message.replace(/^\S+ \S+: /, ''))
              const scope = parseListingId(site, c.listingId) ? c.listingId.replace(/^@/, '').toLowerCase() : null
              if (scope) scopes.push(scope)
              check.status = `excluded: ${e.message}`
            } else if (e instanceof UpstreamError && e.code === 'rate_limited') {
              rateLimited = true
              addSkip(run.skipped, `not read: ${site} rate limit`)
              return
            } else {
              run.errors.push(`${c.listingId}: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
          run.hostedChecks!.push(check)
        },
        { concurrency: options.concurrency ?? 4 },
      )
      if (rateLimited) run.errors.push(`${site} rate limit reached; the remaining skills keep their previous data`)
      run.coverage = { mode: 'scoped', scopes }
      return run
    },
  }
}
