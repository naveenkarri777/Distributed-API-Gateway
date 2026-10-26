// tests/phase5-algorithms.test.ts
//
// Phase 5: Rate Limiting Algorithm Comparison
//
// Tests all 3 algorithms against the same limit (5 req / 10 seconds)
// and shows their different characteristics.
//
// Run with: npm run test:algorithms
// (requires redis mock running: npm run dev:redis)

import Redis from 'ioredis';
import { RedisRateLimiter } from '../src/services/redisRateLimiter';
import { SlidingWindowLimiter } from '../src/services/slidingWindowLimiter';
import { TokenBucketLimiter } from '../src/services/tokenBucketLimiter';
import { RateLimitResult } from '../src/services/rateLimitService';

// ── Config ─────────────────────────────────────────────────────────────────

const WINDOW_MS = 10_000;     // 10 seconds (short for demo)
const MAX_REQUESTS = 5;       // 5 requests per window
const REQUESTS_TO_SEND = 8;   // send 8 to show what happens after limit

// ── Redis Client ────────────────────────────────────────────────────────────

const redis = new Redis('redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function statusIcon(result: RateLimitResult): string {
  return result.allowed ? '✅ ALLOWED' : '🛑 BLOCKED';
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

async function runTest(
  name: string,
  description: string,
  limiter: { consume: (id: string) => Promise<RateLimitResult> },
  clientId: string,
): Promise<void> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Algorithm: ${name}`);
  console.log(`  ${description}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(
    `  ${pad('Request', 10)} ${pad('Status', 15)} ${pad('Remaining', 12)} ${pad('Retry (s)', 10)}`
  );
  console.log(`  ${'─'.repeat(50)}`);

  let allowed = 0;
  let blocked = 0;

  for (let i = 1; i <= REQUESTS_TO_SEND; i++) {
    const result = await limiter.consume(clientId);
    if (result.allowed) allowed++; else blocked++;

    console.log(
      `  ${pad(`Req #${i}`, 10)} ${pad(statusIcon(result), 15)} ` +
      `${pad(`${result.remaining}/${result.limit}`, 12)} ` +
      `${result.allowed ? '—' : `${result.retryAfterSeconds}s`}`
    );
  }

  console.log(`\n  Summary: ${allowed} allowed, ${blocked} blocked out of ${REQUESTS_TO_SEND} requests`);
  const correct = allowed === MAX_REQUESTS && blocked === REQUESTS_TO_SEND - MAX_REQUESTS;
  console.log(`  Result: ${correct ? '🎉 PASS' : '❌ FAIL'} (expected ${MAX_REQUESTS} allowed, ${REQUESTS_TO_SEND - MAX_REQUESTS} blocked)`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await redis.connect();
    console.log('[Redis] Connected to mock server');
  } catch {
    console.error('[Redis] Could not connect. Is "npm run dev:redis" running?');
    process.exit(1);
  }

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       Phase 5 — Rate Limiting Algorithm Comparison       ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Window : ${WINDOW_MS / 1000}s     Limit : ${MAX_REQUESTS} req     Sending : ${REQUESTS_TO_SEND} req           ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  // ── Test 1: Fixed Window ──────────────────────────────────────────────────

  const fixedLimiter = new RedisRateLimiter(redis, WINDOW_MS, MAX_REQUESTS);
  // Clear previous test data
  await redis.del('ratelimit:user:test-fixed');

  await runTest(
    'Fixed Window',
    'Counter resets at fixed clock boundary (e.g. every 10s on the second).',
    fixedLimiter,
    'user:test-fixed',
  );

  // ── Test 2: Sliding Window ────────────────────────────────────────────────

  const slidingLimiter = new SlidingWindowLimiter(redis, WINDOW_MS, MAX_REQUESTS);
  await redis.del('ratelimit:sliding:user:test-sliding');

  await runTest(
    'Sliding Window',
    'Always looks back exactly 10s from NOW. No reset boundary exploit.',
    slidingLimiter,
    'user:test-sliding',
  );

  // ── Test 3: Token Bucket ──────────────────────────────────────────────────

  const refillRatePerSec = MAX_REQUESTS / (WINDOW_MS / 1000);
  const tokenLimiter = new TokenBucketLimiter(redis, MAX_REQUESTS, refillRatePerSec);
  await redis.del('ratelimit:token:user:test-token');

  await runTest(
    'Token Bucket',
    `Tokens refill at ${refillRatePerSec.toFixed(2)} tokens/sec. Allows burst up to ${MAX_REQUESTS}.`,
    tokenLimiter,
    'user:test-token',
  );

  // ── Algorithm Comparison Summary ──────────────────────────────────────────

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║              Algorithm Comparison Summary                ║');
  console.log('╠══════════════════════╦══════════════╦════════════════════╣');
  console.log('║ Algorithm            ║ Redis Cmds   ║ Key Characteristic  ║');
  console.log('╠══════════════════════╬══════════════╬════════════════════╣');
  console.log('║ Fixed Window         ║ INCR+EXPIRE  ║ Burst at boundary   ║');
  console.log('║ Sliding Window       ║ ZADD+ZCARD   ║ Smooth, no burst    ║');
  console.log('║ Token Bucket         ║ HMGET+HSET   ║ Burst then trickle  ║');
  console.log('╚══════════════════════╩══════════════╩════════════════════╝');

  console.log(`
┌─────────────────────────────────────────────────────────────┐
│  THE BURST PROBLEM (Fixed Window weakness):                 │
│                                                             │
│  Window boundary at t=10s                                   │
│  t=9s:  5 requests → ALL ALLOWED  (window 1 full)          │
│  t=11s: 5 requests → ALL ALLOWED  (window 2 reset!)        │
│  ↑ 10 requests in 2 seconds — twice the limit!             │
│                                                             │
│  Sliding Window prevents this:                              │
│  t=11s window looks back to t=1s — sees the 5 requests     │
│  from t=9s — BLOCKS further requests.                       │
│                                                             │
│  Token Bucket prevents this too — but allows a burst        │
│  if you've been idle (tokens accumulated).                  │
└─────────────────────────────────────────────────────────────┘
`);

  console.log('  Change algorithm with env var:');
  console.log('  RATE_LIMIT_ALGORITHM=fixed-window    npm run dev:gateway');
  console.log('  RATE_LIMIT_ALGORITHM=sliding-window  npm run dev:gateway');
  console.log('  RATE_LIMIT_ALGORITHM=token-bucket    npm run dev:gateway');
  console.log('');

  redis.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
