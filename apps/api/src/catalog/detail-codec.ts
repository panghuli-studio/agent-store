import type { GitHubSkillResourceDetail, HostedSkillResourceDetail, ResourceKind, ResourceSummary, SkillHostSite } from '@as/types'
import type { ResourceDetailFields } from './types'

// Skill file download URLs are the bulk of a skill's detail and follow from the
// repo, commit and path (GitHub) or the site, skill, version and path (hosted), so
// they are left out of catalog.db and rebuilt on read.

type GitHubFields = Omit<GitHubSkillResourceDetail, keyof ResourceSummary>
type HostedFields = Omit<HostedSkillResourceDetail, keyof ResourceSummary>

export function rawUrl(repo: string, commit: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`
}

const enc = encodeURIComponent

export const CLAWHUB_BASE = 'https://clawhub.ai'
export const SKILLHUB_BASE = 'https://api.skillhub.cn'

/** The site's URL serving one file of a hosted skill version. */
export function hostedFileUrl(h: Pick<HostedSkillResourceDetail['hosted'], 'site' | 'slug' | 'owner' | 'version'>, path: string): string {
  if (h.site === 'clawhub') {
    return `${CLAWHUB_BASE}/api/v1/skills/${enc(h.slug)}/file?ownerHandle=${enc(h.owner ?? '')}&version=${enc(h.version)}&path=${enc(path)}`
  }
  return `${SKILLHUB_BASE}/api/v1/skills/${enc(h.slug)}/file?version=${enc(h.version)}&path=${enc(path)}`
}

/** The canonical listing of a hosted skill: what users are linked to. */
export function hostedListingUrl(site: SkillHostSite, slug: string, owner: string | null): string {
  return site === 'clawhub' ? `${CLAWHUB_BASE}/${owner}/skills/${slug}` : `https://skillhub.cn/skills/${slug}`
}

export function encodeDetail(kind: ResourceKind, detail: ResourceDetailFields): string {
  if (kind !== 'skill') return JSON.stringify(detail)
  const d = detail as GitHubFields | HostedFields
  return JSON.stringify({ ...d, files: d.files.map(({ downloadUrl: _url, ...f }) => f) })
}

export function decodeDetail(kind: ResourceKind, json: string): ResourceDetailFields {
  const detail = JSON.parse(json) as ResourceDetailFields
  if (kind !== 'skill') return detail
  const d = detail as GitHubFields | HostedFields
  if (d.hosted) {
    const h = d.hosted
    return { ...d, files: d.files.map((f) => ({ ...f, downloadUrl: hostedFileUrl(h, f.path) })) }
  }
  const g = d as GitHubFields
  const prefix = g.repo.dir ? `${g.repo.dir}/` : ''
  return { ...g, files: g.files.map((f) => ({ ...f, downloadUrl: rawUrl(g.repo.fullName, g.repo.commit, prefix + f.path) })) }
}
