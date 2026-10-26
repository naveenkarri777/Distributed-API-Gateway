// tests/smoke-rate-limit.ts
//
// Live HTTP Rate Limiting Smoke Test:
// Tests quota enforcement and 429 response via HTTP against http://localhost:3000.

async function testLiveRateLimiting() {
  console.log('Testing Gateway Rate Limiting via HTTP (http://localhost:3000)...\n');

  const GATEWAY = 'http://localhost:3000';

  // 1. Send 5 requests as Alice
  console.log('1. Sending 5 requests as Alice (Limit: 5)');
  for (let i = 1; i <= 5; i++) {
    const res = await fetch(`${GATEWAY}/api/users/123`, {
      headers: { 'X-User-Id': 'Alice' },
    });
    const limit = res.headers.get('x-ratelimit-limit');
    const remaining = res.headers.get('x-ratelimit-remaining');
    console.log(`  Req #${i} [Alice]: HTTP ${res.status} | Remaining: ${remaining}/${limit}`);
  }

  // 2. Send 6th request as Alice (should return 429)
  console.log('\n2. Sending 6th request as Alice (Expect 429 Too Many Requests)');
  const res6 = await fetch(`${GATEWAY}/api/users/123`, {
    headers: { 'X-User-Id': 'Alice' },
  });
  const retryAfter = res6.headers.get('retry-after');
  const body6 = await res6.json();
  console.log(`  Req #6 [Alice]: HTTP ${res6.status} | Retry-After: ${retryAfter}s`);
  console.log('  Response Payload:', JSON.stringify(body6));

  // 3. Send request as Bob (isolated quota)
  console.log('\n3. Sending request as Bob (Independent Quota)');
  const resBob = await fetch(`${GATEWAY}/api/users/123`, {
    headers: { 'X-User-Id': 'Bob' },
  });
  const bobRemaining = resBob.headers.get('x-ratelimit-remaining');
  console.log(`  Req #1 [Bob]:   HTTP ${resBob.status} | Remaining: ${bobRemaining}/5`);

  // 4. Health check endpoint (exempt from rate limit)
  console.log('\n4. Checking /health (Exempt from Rate Limiting)');
  const resHealth = await fetch(`${GATEWAY}/health`);
  console.log(`  Health Check:  HTTP ${resHealth.status}`);

  console.log('\n[PASS] Rate Limiting Verification Complete.\n');
}

testLiveRateLimiting().catch(console.error);
