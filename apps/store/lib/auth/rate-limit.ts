// The kubelet probes /api/auth/ok every few seconds without a client IP, so the
// probes share one bucket. Better Auth restarts a bucket's count only after a
// whole window with no request, which probes never leave: every ~100 probes it
// answered 429 and failed a readiness check (#216).
export const RATE_LIMIT_RULES = { '/ok': false } as const
