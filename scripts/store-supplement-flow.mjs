// Walks the search supplement end to end on a running store and API (#152): search, agree
// to send the query, wait for the finds, open an installable find in the drawer and as its
// own page, go back, and check the search and its finds are still there. Screenshots each
// step at 390/820/1440 px in zh and en (the store is dark only).
//
//   node store-supplement-flow.mjs <base URL> <out dir> <query> <id of a find>
//
// Against the deployed test environment it sends <query> to the sites the API names, as a
// visitor agreeing to the offer would; the API keeps the answer for a day, so the 6 passes
// ask the sites at most once. Run it in Actions (store-screenshots, workflow_dispatch), not
// on a shared host.
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const [base, out, query, findId] = process.argv.slice(2)
if (!base || !out || !query || !findId) {
  console.error('usage: store-supplement-flow.mjs <base URL> <out dir> <query> <find id>')
  process.exit(2)
}
const WIDTHS = [390, 820, 1440]
const LOCALES = ['zh', 'en']
const listPath = `/store?category=skill&q=${encodeURIComponent(query)}`
const found = '[data-supplement="found"]'
const findLink = `${found} a[data-item-link="${findId}"]`

const browser = await chromium.launch()
const failures = []
await mkdir(out, { recursive: true })

for (const locale of LOCALES) {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 1 })
    await context.addCookies([{ name: 'locale', value: locale, url: base }])
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const tag = `${width}-${locale}`
    const shot = async (name, fullPage = true) => {
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: `${out}/${name}-${tag}.png`, fullPage })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 0) failures.push(`${name}-${tag}: horizontal overflow ${overflow}px`)
    }
    try {
      const res = await page.goto(base + listPath, { waitUntil: 'networkidle', timeout: 60_000 })
      if (!res || res.status() !== 200) throw new Error(`list: HTTP ${res?.status()}`)
      await page.locator('[data-supplement="offer"] button').waitFor({ timeout: 30_000 })
      await shot('flow-1-offer')
      await page.locator('[data-supplement="offer"] button').click()
      await page.locator(`${found}, [data-supplement="none"], [data-supplement="unavailable"]`).first().waitFor({ timeout: 90_000 })
      const state = await page.locator('[data-supplement]').getAttribute('data-supplement')
      if (state !== 'found') throw new Error(`supplement ended ${state}`)
      await page.locator(findLink).waitFor({ timeout: 10_000 })
      await shot('flow-2-found')

      await page.locator(findLink).click()
      const drawer = page.locator('[data-item-drawer]')
      await drawer.waitFor({ timeout: 30_000 })
      await drawer.locator('[data-install-state]').first().waitFor({ timeout: 30_000 })
      await page.waitForLoadState('networkidle')
      await shot('flow-3-drawer', false)

      await page.goBack({ waitUntil: 'networkidle' })
      await drawer.waitFor({ state: 'detached', timeout: 30_000 })
      if (!(await page.locator(findLink).isVisible())) throw new Error('back in the list: the finds are gone')
      if (!page.url().includes(`q=${encodeURIComponent(query).replace(/%20/g, '+')}`) && !page.url().includes(`q=${encodeURIComponent(query)}`)) {
        throw new Error(`back in the list: URL lost the query (${page.url()})`)
      }
      await shot('flow-4-back')

      // The find's own page, as from a shared link.
      const href = await page.locator(findLink).getAttribute('href')
      const detail = await page.goto(base + href, { waitUntil: 'networkidle', timeout: 60_000 })
      if (!detail || detail.status() !== 200) throw new Error(`detail page: HTTP ${detail?.status()}`)
      await page.locator('[data-install-state]').first().waitFor({ timeout: 30_000 })
      await shot('flow-5-page')
      console.log(`ok ${tag}`)
    } catch (e) {
      failures.push(`${tag}: ${e.message}`)
      await page.screenshot({ path: `${out}/failed-${tag}.png`, fullPage: true }).catch(() => {})
    }
    if (errors.length) failures.push(`${tag}: page errors: ${errors.join(' | ')}`)
    await context.close()
  }
}
await browser.close()
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
