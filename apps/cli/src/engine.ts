import { EngineImpl } from '@as/client-core'
import { ensureRelayRunning, stopRelay } from './commands/relay'
import { realRelayOps } from './relay-ops'

// The default must be the public store: the desktop client spawns this CLI as its
// sidecar without AS_STORE_URL. Local dev and tests set AS_STORE_URL themselves.
const DEFAULT_STORE_URL = 'https://agent-store-test.panghuli.tech'

// Client id of the OAuth app (device flow enabled) that backups sign in to GitHub with. It is not a
// secret; the device flow uses no client secret. Uses the existing agent-store OAuth app (#231).
// AS_GITHUB_CLIENT_ID overrides it, AS_GITHUB_URL and AS_GITHUB_API_URL point at another GitHub.
const DEFAULT_GITHUB_CLIENT_ID = 'Ov23libYqp7LUPlxHdMN'

export function createEngine(): EngineImpl {
  const storeUrl = process.env['AS_STORE_URL'] ?? DEFAULT_STORE_URL
  // Deployed, the store and the API share one origin. Locally AS_STORE_URL is the API alone, and
  // the store's /api/auth/* (the desktop sign-in) lives at AS_AUTH_URL.
  const authUrl = process.env['AS_AUTH_URL'] || undefined
  // The desktop client enables providers through this CLI too, so enabling one starts the relay it points at.
  return new EngineImpl(undefined, storeUrl, {
    authUrl,
    github: {
      clientId: process.env['AS_GITHUB_CLIENT_ID'] || DEFAULT_GITHUB_CLIENT_ID,
      webUrl: process.env['AS_GITHUB_URL'] || undefined,
      apiUrl: process.env['AS_GITHUB_API_URL'] || undefined,
    },
    startRelay: async () => { await ensureRelayRunning(realRelayOps()) },
    stopRelay: async () => { await stopRelay(realRelayOps()) },
  })
}
