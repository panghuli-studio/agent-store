import type {
  GitHubSkillResourceDetail,
  HostedSkillResourceDetail,
  McpResourceDetail,
  ProviderResourceDetail,
  ResourceOrigin,
  ResourceSummary,
  SkillResourceDetail,
} from '@as/types'

function origin(site: ResourceOrigin['site'], upstreamId: string, url: string | null = null): ResourceOrigin {
  return {
    site,
    upstreamId,
    url,
    upstreamVersion: null,
    upstreamUpdatedAt: '2026-11-10T00:00:00Z',
    syncedAt: '2026-11-12T00:00:00Z',
    unavailableAt: null,
    unavailableReason: null,
  }
}

export const providerResource: ProviderResourceDetail = {
  id: 'builtin:openrouter',
  kind: 'provider',
  name: 'OpenRouter',
  description: 'One API key for 300+ models.',
  author: { name: 'OpenRouter', url: 'https://openrouter.ai' },
  version: '1.0.0',
  homepageUrl: 'https://openrouter.ai',
  installs: null,
  stars: null,
  verified: true,
  tags: ['router'],
  transports: [],
  origin: origin('builtin', 'openrouter'),
  compatibleWith: ['claude', 'codex'],
  connection: { baseUrl: 'https://openrouter.ai/api', authType: 'bearer' },
  configSchema: {},
  supportedModels: ['anthropic/claude-sonnet-4'],
}

const noInput = { description: null, isRequired: false, isSecret: false, default: null, value: null, placeholder: null, choices: [], format: null }

export const mcpResource: McpResourceDetail = {
  id: 'mcp-registry:io.github.ankimcp/anki-mcp-server',
  kind: 'mcp',
  name: 'Anki MCP',
  description: 'Read and write Anki cards',
  author: { name: 'ankimcp', url: 'https://github.com/ankimcp' },
  version: '0.8.0',
  homepageUrl: null,
  installs: null,
  stars: 1_250,
  verified: false,
  tags: ['npm'],
  transports: ['npm'],
  origin: origin('mcp-registry', 'io.github.ankimcp/anki-mcp-server', 'https://registry.modelcontextprotocol.io/v0/servers/x'),
  title: null,
  status: 'active',
  statusMessage: null,
  publishedAt: null,
  repository: { url: 'https://github.com/ankimcp/anki-mcp-server', source: 'github', subfolder: null },
  icons: [],
  packages: [
    {
      registryType: 'npm',
      identifier: '@ankimcp/anki-mcp-server',
      version: '0.8.0',
      registryBaseUrl: null,
      runtimeHint: null,
      fileSha256: null,
      transport: { type: 'stdio', url: null, headers: [], variables: {} },
      runtimeArguments: [],
      packageArguments: [],
      environmentVariables: [{ ...noInput, name: 'ANKI_TOKEN', isRequired: true, isSecret: true, variables: {} }],
    },
  ],
  remotes: [],
}

export const skillResource: GitHubSkillResourceDetail = {
  id: 'github:obra/superpowers/brainstorming',
  kind: 'skill',
  name: 'brainstorming',
  description: 'Explore intent before building. Use it before any creative work.',
  author: { name: 'obra', url: 'https://github.com/obra' },
  version: '76a98a285cb0',
  homepageUrl: 'https://github.com/obra/superpowers',
  installs: 12_400,
  stars: 152_300,
  verified: false,
  tags: [],
  transports: [],
  origin: origin('github', 'obra/superpowers/brainstorming'),
  repo: {
    fullName: 'obra/superpowers',
    ref: 'HEAD',
    commit: 'abc123',
    dir: 'skills/brainstorming',
    treeSha: '76a98a285cb0',
    url: 'https://github.com/obra/superpowers/tree/abc123/skills/brainstorming',
  },
  frontmatter: { name: 'brainstorming' },
  files: [
    { path: 'SKILL.md', type: 'file', mode: '100644', size: 10, sha: 's1', downloadUrl: 'https://raw.githubusercontent.com/obra/superpowers/abc123/skills/brainstorming/SKILL.md' },
    { path: 'scripts/run.sh', type: 'file', mode: '100755', size: 10, sha: 's2', downloadUrl: 'https://raw.githubusercontent.com/obra/superpowers/abc123/skills/brainstorming/scripts/run.sh' },
  ],
  archiveUrl: 'https://codeload.github.com/obra/superpowers/tar.gz/abc123',
}

export const hostedSkillResource: HostedSkillResourceDetail = {
  id: 'clawhub:ivangdavila/terraform',
  kind: 'skill',
  name: 'Terraform',
  description: 'Writes, debugs, and refactors Terraform.',
  author: { name: 'Iván', url: null },
  version: '1.0.4',
  homepageUrl: 'https://clawhub.ai/ivangdavila/skills/terraform',
  installs: 123,
  stars: null,
  verified: false,
  tags: [],
  transports: [],
  origin: origin('clawhub', 'ivangdavila/terraform', 'https://clawhub.ai/ivangdavila/skills/terraform'),
  hosted: {
    site: 'clawhub',
    listingId: 'ivangdavila/terraform',
    slug: 'terraform',
    owner: 'ivangdavila',
    version: '1.0.4',
    url: 'https://clawhub.ai/ivangdavila/skills/terraform',
  },
  frontmatter: { name: 'Terraform' },
  files: [
    {
      path: 'SKILL.md', size: 19174, sha256: '9d58f88d634515f9dd9ecdfa3a30b475f3e5cf764ae72b8635d1cbed4fc0962b',
      downloadUrl: 'https://clawhub.ai/api/v1/skills/terraform/file?ownerHandle=ivangdavila&version=1.0.4&path=SKILL.md',
    },
  ],
}

/** The list endpoint's shape: the summary fields only. */
export function summary(r: ResourceSummary): ResourceSummary {
  const { id, kind, name, description, author, version, homepageUrl, installs, stars, verified, tags, transports, origin } = r
  return { id, kind, name, description, author, version, homepageUrl, installs, stars, verified, tags, transports, origin }
}
