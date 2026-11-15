import { expect, test } from 'bun:test'
import { betterAuth } from 'better-auth'
import { RATE_LIMIT_RULES } from '../auth/rate-limit'

const BASE = 'http://localhost:3000'

// Probes carry no client IP and come every few seconds, faster than the window can lapse.
async function probe(rules?: typeof RATE_LIMIT_RULES): Promise<number[]> {
  const auth = betterAuth({
    baseURL: BASE,
    secret: 'test-secret-at-least-32-characters-long',
    rateLimit: { enabled: true, ...(rules ? { customRules: rules } : {}) },
  })
  const statuses: number[] = []
  for (let i = 0; i < 120; i++) statuses.push((await auth.handler(new Request(`${BASE}/api/auth/ok`))).status)
  return statuses
}

test('without the rule, probes of /ok are rate limited', async () => {
  expect(await probe()).toContain(429)
})

test('with the store rules, /ok always answers', async () => {
  expect(new Set(await probe(RATE_LIMIT_RULES))).toEqual(new Set([200]))
})
