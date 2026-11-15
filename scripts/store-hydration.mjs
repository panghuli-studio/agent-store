// Loads the web store's key pages repeatedly and fails on any hydration error (#214).
// Documents go through a local proxy that holds each chunk back 0-400 ms, the way a
// remote network splits the stream: the error only shows when the browser starts
// hydrating, from cached scripts, before the document has finished arriving.
// One page per locale and width is reused so the scripts come from its cache.
// Usage: node scripts/store-hydration.mjs <base-url> [rounds]
import http from 'node:http'
import { chromium } from 'playwright'

const [target = 'http://localhost:3000', rounds = '3'] = process.argv.slice(2)
const PAGES = ['/', '/client', '/pricing', '/store', '/store?state=error', '/docs']
const PORT = 3999

const up = new URL(target)
const proxy = http.createServer((req, res) => {
  const forward = http.request(
    { host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } },
    (upstream) => {
      res.writeHead(upstream.statusCode, upstream.headers)
      const slow = (upstream.headers['content-type'] ?? '').includes('text/html')
      let chain = Promise.resolve()
      upstream.on('data', (chunk) => {
        chain = chain.then(() => slow && new Promise((r) => setTimeout(r, Math.random() * 400))).then(() => res.write(chunk))
      })
      upstream.on('end', () => chain.then(() => res.end()))
    }
  )
  forward.on('error', () => res.destroy())
  req.pipe(forward)
})
await new Promise((r) => proxy.listen(PORT, r))
const base = `http://localhost:${PORT}`

const browser = await chromium.launch()
const failures = []
let loads = 0
for (const locale of ['zh', 'en']) {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' })
    await context.addCookies([{ name: 'locale', value: locale, url: base }])
    const page = await context.newPage()
    let errors = []
    page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]))
    page.on('console', (m) => {
      if (m.type() === 'error' && /hydrat|#418|#423|#425/i.test(m.text())) errors.push(m.text().split('\n')[0])
    })
    for (let round = 0; round < Number(rounds); round++) {
      for (const path of PAGES) {
        errors = []
        loads++
        try {
          await page.goto(base + path, { waitUntil: 'load', timeout: 30_000 })
          await page.waitForTimeout(500)
        } catch (e) {
          errors.push(e.message.split('\n')[0])
        }
        if (errors.length) failures.push(`${locale}/${width} round ${round} ${path}: ${errors.join(' | ')}`)
      }
    }
    await context.close()
  }
}
await browser.close()
proxy.close()
console.log(`${loads} loads, ${failures.length} with errors`)
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
