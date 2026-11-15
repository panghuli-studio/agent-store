import { app } from './app'
import { startCatalog } from './catalog/runtime'

const port = Number(process.env['PORT'] ?? '3001')
// `::` accepts IPv4 and IPv6; the k3s cluster is IPv6-only, where Bun's default
// 0.0.0.0 would leave the pod unreachable.
const hostname = process.env['HOST'] ?? '::'

startCatalog()

const server = Bun.serve({ port, hostname, fetch: app.fetch })

// eslint-disable-next-line no-console
console.log(JSON.stringify({ level: 'info', message: 'as-api listening', hostname, port }))

// The process is PID 1 in its container, where a signal without a handler is ignored:
// without this every rollout waited out terminationGracePeriodSeconds (#211).
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    setTimeout(() => process.exit(0), 10_000).unref()
    void server.stop().then(() => process.exit(0))
  })
}
