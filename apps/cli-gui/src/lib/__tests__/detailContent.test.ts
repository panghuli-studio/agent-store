import { test, expect } from 'bun:test'
import type { CatalogResourceDetail, SkillItem } from '@as/types'
import { messages } from '../../i18n/messages'
import { installStepsOf, typeFacts, type SelectedDetail } from '../detailContent'

const resolve = (tree: unknown, key: string): string | undefined => {
  const v = key.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k] : undefined), tree)
  return typeof v === 'string' ? v : undefined
}
const tOf = (locale: 'zh' | 'en') => (key: string) => resolve(messages[locale], key) ?? key

const hostedItem: SkillItem = {
  id: 'clawhub:ivangdavila/terraform', resourceId: 'clawhub:ivangdavila/terraform', slug: 'ivangdavila-terraform', name: 'Terraform',
  description: '', category: 'skill', version: '1.0.4', compatibleWith: ['claude', 'codex'], tags: [], downloads: 0,
  status: 'published', installHook: { steps: [] }, createdAt: '', updatedAt: '',
  publisher: { id: 'x', slug: 'x', name: 'x', avatarUrl: '', tier: 'community' },
  contentUrl: '',
  hosted: {
    site: 'clawhub', listingId: 'ivangdavila/terraform', version: '1.0.4', url: 'https://clawhub.ai/ivangdavila/skills/terraform',
    files: [
      { path: 'SKILL.md', size: 10, sha256: 'a'.repeat(64), downloadUrl: 'https://clawhub.ai/x' },
      { path: 'ci.md', size: 10, sha256: 'b'.repeat(64), downloadUrl: 'https://clawhub.ai/y' },
    ],
  },
}
const detail = { ...hostedItem, installed: false, resource: { kind: 'skill' } as CatalogResourceDetail } as SelectedDetail

test('the install preview of a hosted skill names its site and the SHA-256 check, in both locales', () => {
  expect(installStepsOf(detail, tOf('en'))).toEqual([
    "file · download the skill files from ClawHub, check each file's SHA-256, and only if all match save them to ~/.agent-store/skills/ivangdavila-terraform",
    "link · link into each enabled client's skills folder",
  ])
  expect(typeFacts(detail, tOf('en'))).toEqual([
    'Source: ClawHub ivangdavila/terraform · version 1.0.4',
    '2 files, each checked against its SHA-256 at install',
  ])
  expect(installStepsOf(detail, tOf('zh'))[0]).toBe('file · 从 ClawHub 下载技能文件，逐个核对 SHA-256，全部一致才存到 ~/.agent-store/skills/ivangdavila-terraform')
  expect(typeFacts(detail, tOf('zh'))[1]).toBe('2 个文件，安装时逐个核对 SHA-256')
})
