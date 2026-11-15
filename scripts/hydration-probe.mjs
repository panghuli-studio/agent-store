// TEMPORARY diagnostic for #214; removed before merge.
// Usage: node hydration-probe.mjs <base> <rounds> [patch]
import { chromium } from 'playwright'
import http from 'node:http'

const [target, rounds = '10', patch, slow] = process.argv.slice(2)
// With `slow`, documents pass through a proxy that holds each chunk back for a random
// 0-400 ms, like a remote network does; static assets pass straight through.
let base = target
if (slow) {
  const up = new URL(target)
  const server = http.createServer((req, res) => {
    const preq = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, async (pres) => {
      res.writeHead(pres.statusCode, pres.headers)
      const doc = (pres.headers['content-type'] || '').includes('text/html')
      let chain = Promise.resolve()
      pres.on('data', (c) => {
        chain = chain.then(() => (doc ? new Promise((r) => setTimeout(r, Math.random() * 400)) : null)).then(() => res.write(c))
      })
      pres.on('end', () => chain.then(() => res.end()))
    })
    req.pipe(preq)
  })
  await new Promise((r) => server.listen(3100, r))
  server.unref()
  base = 'http://localhost:3100'
}
const PAGES = ['/pricing', '/store?state=error', '/', '/store', '/docs', '/client']
const INJECT = (s) => {
  const m = s.match(/var (\w+)=null,(\w+)=null,(\w+)=!1,(\w+)=null,(\w+)=!1,(\w+)=Error\(\w+\(519\)\);function (\w+)\(e\)\{/)
  if (!m) return null
  const [all, P, N] = m
  const inj = `try{window.__hyd=window.__hyd||[];var _f=e,_p=[];for(var k=0;_f&&k<40;k++){var ty=_f.type;_p.push((typeof ty==='string'?ty:(ty&&(ty.displayName||ty.name))||('tag'+_f.tag))+(_f.pendingProps&&typeof _f.pendingProps.className==='string'?'.'+_f.pendingProps.className.slice(0,25):'')+(_f.pendingProps&&_f.pendingProps.id?'#'+_f.pendingProps.id:''));_f=_f.return}var d=function(x){return x?(x.nodeType===1?x.outerHTML.slice(0,160):x.nodeType+':'+String(x.data||x.nodeValue).slice(0,60)):String(x)};var sib=[];for(var q=${N},z=0;q&&z<6;z++,q=q.nextSibling)sib.push(d(q));window.__hyd.push({path:_p.join(' < '),props:e.pendingProps&&typeof e.pendingProps==='object'?Object.keys(e.pendingProps).join(','):String(e.pendingProps),next:sib,nextParent:${N}&&${N}.parentNode?d(${N}.parentNode).slice(0,100):null,parent:${P}&&${P}.stateNode&&${P}.stateNode.nodeName?d(${P}.stateNode).slice(0,100):String(${P}&&${P}.tag),ready:document.readyState,t:performance.now()|0,stack:new Error().stack.split('\\n').slice(1,8).join(' | ')})}catch(x){(window.__hyd=window.__hyd||[]).push(String(x))}`
  return s.replace(all, all + inj)
}

const browser = await chromium.launch()
let total = 0
let failed = 0
for (const locale of ['en', 'zh']) {
  for (const width of [390, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' })
    await ctx.addCookies([{ name: 'locale', value: locale, url: base }])
    if (patch) {
      const cache = new Map()
      await ctx.route('**/_next/static/chunks/*.js', async (route) => {
        const url = route.request().url()
        if (!cache.has(url)) {
          const res = await route.fetch()
          const body = await res.text()
          cache.set(url, INJECT(body))
          if (cache.get(url)) console.log('patched', url)
        }
        const body = cache.get(url)
        if (body) return route.fulfill({ status: 200, contentType: 'application/javascript', body })
        return route.continue()
      })
    }
    await ctx.addInitScript(() => {
      window.__ev = []
      const t0 = () => performance.now() | 0
      document.addEventListener('readystatechange', () => window.__ev.push([t0(), 'ready:' + document.readyState]))
      window.addEventListener('error', (e) => window.__ev.push([t0(), 'error:' + String(e.message).slice(0, 60)]))
      new MutationObserver((recs) => {
        for (const r of recs) {
          for (const n of r.removedNodes) if (n.nodeType === 1 && n.id && /^S:/.test(n.id)) window.__ev.push([t0(), 'segment-removed ' + n.id])
          for (const n of r.addedNodes) if (n.nodeType === 1 && n.id && /^S:/.test(n.id)) window.__ev.push([t0(), 'segment-parsed ' + n.id])
        }
      }).observe(document, { childList: true, subtree: true })
    })
    const page = await ctx.newPage()
    let errs = []
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 12000)))
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text().slice(0, 4000))
    })
    for (let r = 0; r < Number(rounds); r++) {
      for (const p of PAGES) {
        errs = []
        total++
        try {
          await page.goto(base + p, { waitUntil: 'load', timeout: 30_000 })
          await page.waitForTimeout(1500)
        } catch (e) {
          console.log(`${locale}/${width} ${p} goto: ${e.message.split('\n')[0]}`)
          continue
        }
        if (errs.length) {
          failed++
          const info = await page.evaluate(() => ({ hyd: window.__hyd, ev: window.__ev }))
          console.log(`FAIL ${locale}/${width} round ${r} ${p}\n  ${errs.join('\n  ')}\n  ${JSON.stringify(info, null, 1)}`)
        }
      }
    }
    await ctx.close()
  }
}
await browser.close()
console.log(`hydration probe: ${failed} of ${total} loads had errors`)
