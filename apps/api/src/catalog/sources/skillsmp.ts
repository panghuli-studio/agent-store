import { isRecord, str } from '../http'
import type { ExternalFind, SearchSource } from '../search-sources'
import { githubRepoOf } from '../stars'

// SkillsMP indexes SKILL.md files on GitHub. Its REST API (skillsmp.com/docs/api) only
// searches by keyword or creator and cannot list, so it is no discovery board; it is
// the one search whose hits name a GitHub repo and skill. Anonymous callers get 50
// searches a day and 10 a minute; with an API key the free allowance is the same.
export const SKILLSMP_URL = 'https://skillsmp.com'

/**
 * The directory a SkillsMP `githubUrl` points at (`…/tree/<branch>/<dir>`, or a `blob/…`
 * SKILL.md in it), or null for the repo root or another URL. The branch is taken to be
 * one segment; the directory is read at the default branch head either way.
 */
export function githubDirOf(url: string | null): string | null {
  const m = url?.trim().match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(tree|blob)\/[^/]+\/([^?#]+?)\/?(?:[?#].*)?$/i)
  if (!m) return null
  let segments: string[]
  try {
    segments = m[2]!.split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  if (m[1]!.toLowerCase() === 'blob') {
    if (segments.at(-1) !== 'SKILL.md') return null
    segments = segments.slice(0, -1)
  }
  return segments.length ? segments.join('/') : null
}

export function skillsmpSearch(options: { baseUrl?: string; apiKey?: string } = {}): SearchSource {
  const base = options.baseUrl ?? SKILLSMP_URL
  return {
    name: 'skillsmp',
    hosts: [new URL(base).hostname],
    budget: { perMinute: 5, perDay: 40 },
    async search(http, q, limit): Promise<ExternalFind[]> {
      const url = new URL('/api/v1/skills/search', base)
      url.searchParams.set('q', q)
      url.searchParams.set('limit', String(limit))
      const body = await http
        .get(url.toString(), options.apiKey ? { headers: { authorization: `Bearer ${options.apiKey}` } } : {})
        .json<unknown>()
      const data = isRecord(body) && body['success'] === true && isRecord(body['data']) ? body['data'] : null
      if (!data || !Array.isArray(data['skills'])) throw new Error('search: unexpected response shape')
      return data['skills'].filter(isRecord).flatMap((item) => {
        const id = str(item['id'])
        const name = str(item['name'])
        const githubUrl = str(item['githubUrl'])
        const repo = githubRepoOf(githubUrl)
        const listing = str(item['skillUrl'])
        if (!id || !name || !repo || !listing) return []
        return [{
          source: 'skillsmp',
          listingId: id.toLowerCase(),
          // The same key skills.sh entries and scanned repos get, so they are one skill.
          skillKey: `github:${repo}/${name.toLowerCase()}`,
          name,
          description: str(item['description']),
          author: str(item['author']),
          url: listing,
          githubRepo: repo,
          githubDir: githubDirOf(githubUrl),
        }]
      })
    },
  }
}
