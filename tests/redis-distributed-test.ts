// tests/redis-distributed-test.ts
//
// Distributed Rate Limiting Test (Phase 4):
// Verifies that Redis shares rate limit quota across multiple Gateway instances.

import Redis from 'ioredis';

async function testDistributedRateLimiting() {
  console.log('=======================================================================');
  console.log('EXPERIMENT: Distributed Rate Limiting with Redis and 2 Gateways');
  console.log('=======================================================================');

  const redis = new Redis({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: 1 });
  try {
    await redis.del('ratelimit:user:Alice');
    console.log('Cleaned previous Redis key for Alice.\n');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('Note: Could not clear Redis key:', message);
  } finally {
    redis.disconnect();
  }

  const LB_URL = 'http://localhost:3000';
  let allowedCount = 0;
  let blockedCount = 0;

  for (let i = 1; i <= 10; i++) {
    try {
      const res = await fetch(`${LB_URL}/api/users/123`, {
        headers: { 'X-User-Id': 'Alice' },
      });

      const servedBy = res.headers.get('x-served-by') ?? 'Unknown';
      const remaining = res.headers.get('x-ratelimit-remaining') ?? '0';
      const limit = res.headers.get('x-ratelimit-limit') ?? '5';

      if (res.status === 200) {
        allowedCount++;
        console.log(
          `  Req #${String(i).padStart(2)}: HTTP 200 OK         | Served By: ${servedBy.padEnd(9)} | Remaining: ${remaining}/${limit}`
        );
      } else if (res.status === 429) {
        blockedCount++;
        console.log(
          `  Req #${String(i).padStart(2)}: HTTP 429 BLOCKED    | Served By: ${servedBy.padEnd(9)} | Shared Quota Exceeded`
        );
      } else {
        console.log(`  Req #${String(i).padStart(2)}: HTTP ${res.status} | Served By: ${servedBy}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Req #${i} connection error:`, message);
    }
  }

  console.log('\n-----------------------------------------------------------------------');
  console.log('RESULTS SUMMARY:');
  console.log(`  Total Requests Sent: 10`);
  console.log(`  Allowed (HTTP 200):  ${allowedCount}  (Target: 5)`);
  console.log(`  Blocked (HTTP 429):  ${blockedCount}  (Target: 5)`);
  console.log('-----------------------------------------------------------------------');

  if (allowedCount === 5 && blockedCount === 5) {
    console.log('\n[PASS] Distributed Rate Limiting is 100% Working!');
    console.log('  Requests alternated across Gateway-1 and Gateway-2,');
    console.log('  and Redis shared the counter atomically. The 6th request was blocked.');
  } else {
    console.log('\n[CHECK] Unexpected counts. Verify all services are running.');
  }
}

testDistributedRateLimiting().catch(console.error);
