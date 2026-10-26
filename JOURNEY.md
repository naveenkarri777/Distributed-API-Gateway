# Distributed API Gateway — Complete Journey

> Built step by step in TypeScript. Every phase adds one real concept with a clear reason why.

---

## Table of Contents

1. [What We Are Building](#what-we-are-building)
2. [Phase 1 — Basic HTTP Proxy](#phase-1--basic-http-proxy)
3. [Phase 2 — Multi-Service Routing](#phase-2--multi-service-routing)
4. [Phase 3 — In-Memory Rate Limiter and The Flaw](#phase-3--in-memory-rate-limiter-and-the-flaw)
5. [Phase 4 — Distributed Rate Limiter with Redis](#phase-4--distributed-rate-limiter-with-redis)
6. [Phase 5 — Rate Limiting Algorithms (Fixed vs Sliding vs Token Bucket)](#phase-5--rate-limiting-algorithms)
7. [Phase 6 — Reliability: Timeout, Retry + Backoff, and Circuit Breaker](#phase-6--reliability-timeout-retry--backoff-and-circuit-breaker)
8. [Phase 7 — Docker Full Ecosystem Setup](#phase-7--docker-full-ecosystem-setup-)
9. [Phase 8 — Observability: Structured Logging, Prometheus & Grafana](#phase-8--observability-structured-logging-prometheus--grafana-)
10. [File Purpose Reference](#file-purpose-reference)
11. [Key Concepts Glossary](#key-concepts-glossary)
12. [Roadmap](#roadmap)

---

## What We Are Building

A production-style **API Gateway** — a single entry point that sits in front of all your backend services.

Instead of clients knowing the address of every service, they only know one address: the gateway.

```
Client
  │
  ▼
API Gateway  ← authentication, rate limiting, routing, proxying
  │
  ├── User Service    (accounts, profiles)
  ├── Order Service   (shopping, carts)
  └── Payment Service (billing, transactions)
```

**Why build this instead of calling services directly?**

| Problem | Gateway Solution |
|---------|-----------------|
| Every client must know every service URL | One URL for everything |
| Cannot rate-limit at the service level easily | Gateway enforces limits centrally |
| No central place to log all traffic | Gateway logs every request |
| Services get spammed directly by bad clients | Gateway is the single shield |

---

# Phase 1 — Basic HTTP Proxy

## What We Built

```
curl http://localhost:3000/api/users/1
        │
        ▼
  API Gateway :3000
        │  forwards to
        ▼
  User Service :4001
        │
        ▼
  {"id":1,"name":"Alice"}
```

## Files Created

```
src/
├── config/env.ts
├── middleware/requestLogger.ts
├── gateway/
│   ├── proxy.ts
│   └── routes.ts
├── app.ts
└── server.ts

services/
└── user-service/index.ts
```

---

## src/config/env.ts — Why It Exists

All config (ports, URLs) read from environment variables in one place.

```typescript
export const config = {
  GATEWAY_PORT: parseInt(process.env.GATEWAY_PORT ?? '3000', 10),
  USER_SERVICE_URL: process.env.USER_SERVICE_URL ?? 'http://localhost:4001',
};
```

**Why:** If you hard-code URLs in 5 files, changing it means editing 5 files.
With env.ts, you change it in ONE place. In production inject a real URL via environment variable — code never changes.

---

## src/middleware/requestLogger.ts — Why It Exists

```typescript
export function requestLogger(req, res, next): void {
  const start = Date.now();
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);

  res.on('finish', () => {
    const latencyMs = Date.now() - start;
    console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${latencyMs}ms)`);
  });

  next();
}
```

**Why:** Without this you are flying blind. You can't see what's coming in or how long it takes.
`res.on('finish')` fires after the full response is sent — that's how we measure total latency.
It does NOT block the request. Registers a callback and calls next() immediately.

---

## src/gateway/proxy.ts — Why It Exists

```typescript
export function createServiceProxy(targetUrl, pathRewrite, pathFilter) {
  return createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,    // rewrites Host header to match upstream
    pathRewrite,           // /api/users/1 becomes /users/1
    pathFilter,            // only forward matching paths
    on: {
      error: (err, _req, res) => { /* 502 Bad Gateway */ }
    }
  });
}
```

**Why:** The gateway must forward requests to backend services.
`changeOrigin: true` rewrites `Host: localhost:3000` to `Host: localhost:4001` so upstream accepts it.
`pathRewrite` strips the gateway prefix before forwarding.

---

## src/gateway/routes.ts — Why It Exists

```typescript
const serviceRoutes = [
  { pathPrefix: '/api/users', targetUrl: 'http://localhost:4001', targetPrefix: '/users' },
];

for (const route of serviceRoutes) {
  router.use(createServiceProxy(route.targetUrl, pathRewrite, route.pathPrefix));
}
```

**Why:** proxy.ts knows HOW to forward. routes.ts knows WHERE to forward.
Adding a new backend = add one line to the array. No proxy logic changes needed.

---

## src/app.ts — Why It Exists

```typescript
const app = express();
app.use(requestLogger);       // 1st — logs everything
app.use(rateLimiter);         // 2nd — blocks excess traffic
app.use('/', gatewayRoutes);  // 3rd — routes to upstream
```

**Why:** Defines the ORDER middleware runs. Order matters.
Logger first (sees everything). Rate limiter before routes (blocked requests never reach proxy).
Separated from server.ts so tests can import app without starting a real server.

---

## src/server.ts — Why It Exists

```typescript
import app from './app';
app.listen(config.GATEWAY_PORT);
```

**Why:** Its only job is to call app.listen(). Nothing else.
Tests import app.ts directly without this file — no side effects.

---

## services/user-service/index.ts — Why It Exists

```typescript
app.get('/users/:id', (req, res) => {
  res.json({ id: 1, name: 'Alice' });
});
app.listen(4001);
```

**Why:** We need a real HTTP server to proxy to.
This stub has NO idea the gateway exists — completely decoupled.
That is the core architectural point: services don't change when you add a gateway in front.

---

## Phase 1 Key Lesson

The gateway is just a smart middleman. Backend services don't change at all. You add a layer in front.

---

# Phase 2 — Multi-Service Routing

## What We Built

```
/api/users/*    → User Service    :4001
/api/orders/*   → Order Service   :4002
/api/payments/* → Payment Service :4003
```

## Files Added

```
services/
├── order-service/index.ts
├── payment-service/index.ts
└── run-all.ts
```

routes.ts was updated with the full routing table for all 3 services.

## services/run-all.ts — Why It Exists

```typescript
for (const svc of services) {
  spawn(process.execPath, [tsxCli, 'watch', svc.script], { stdio: 'inherit' });
}
```

**Why:** Opening 3 separate terminals is tedious.
This spawns all 3 as child processes in one terminal with `npm run dev:services`.

## Phase 2 Key Lesson

Adding a new backend = one line in the routes array. Proxy logic never changes.

---

# Phase 3 — In-Memory Rate Limiter and The Flaw

## What We Built

Max 5 requests per 60 seconds per client.

```
Request 1 → allowed  (count: 1/5)
Request 2 → allowed  (count: 2/5)
Request 3 → allowed  (count: 3/5)
Request 4 → allowed  (count: 4/5)
Request 5 → allowed  (count: 5/5)
Request 6 → BLOCKED  429 Too Many Requests
```

## Files Added

```
src/
├── services/rateLimitService.ts
└── middleware/rateLimiter.ts
```

---

## src/services/rateLimitService.ts — How It Works

```typescript
export class InMemoryRateLimiter {
  private store: Map<string, ClientRecord> = new Map();
  // key   = "user:Alice"
  // value = { count: 3, resetTime: 1697182920000 }

  public consume(clientId: string): RateLimitResult {
    const now = Date.now();
    let record = this.store.get(clientId);

    // No record OR window expired → fresh start
    if (!record || now >= record.resetTime) {
      record = { count: 1, resetTime: now + this.windowMs };
      this.store.set(clientId, record);
      return { allowed: true, remaining: this.maxRequests - 1 };
    }

    record.count += 1;
    const allowed = record.count <= this.maxRequests;
    return { allowed, remaining: Math.max(0, this.maxRequests - record.count) };
  }
}
```

**Why a Map:** O(1) lookup. Each client gets their own slot. Key = identity.
**Why cleanup interval:** Without it, inactive clients stay in memory forever. Every 60s, expired records are deleted.

---

## src/middleware/rateLimiter.ts — How It Works

```typescript
export async function rateLimiter(req, res, next): Promise<void> {
  const clientId = getClientId(req);
  // Priority: x-user-id → x-api-key → IP address

  const result = await rateLimiterService.consume(clientId);

  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);

  if (!result.allowed) {
    res.status(429).json({ error: 'Too Many Requests' });
    return;   // STOP chain. proxy never runs.
  }

  next();     // allowed. continue to routes.
}
```

**Why x-user-id over IP:** Multiple users share the same IP (office wifi, NAT).
**Why set headers even when allowed:** Clients use these to show "X requests remaining" in their UI.

---

## The Flaw — Why In-Memory Is Not Enough

Run 2 gateway instances:

```
Gateway-1 (port 3001) → has its OWN Map in memory
Gateway-2 (port 3002) → has its OWN Map in memory
```

Alice sends 10 requests through the Load Balancer:

```
Req 1  → Gateway-1  G1 counter: 1  allowed
Req 2  → Gateway-2  G2 counter: 1  allowed  (G2 doesn't know G1 count!)
Req 3  → Gateway-1  G1 counter: 2  allowed
Req 4  → Gateway-2  G2 counter: 2  allowed
Req 5  → Gateway-1  G1 counter: 3  allowed
Req 6  → Gateway-2  G2 counter: 3  allowed
Req 7  → Gateway-1  G1 counter: 4  allowed
Req 8  → Gateway-2  G2 counter: 4  allowed
Req 9  → Gateway-1  G1 counter: 5  allowed
Req 10 → Gateway-2  G2 counter: 5  allowed  ← should be blocked! total is 10!
```

Alice got 10 requests instead of 5. The limit is completely bypassed.
Neither instance knows what the other is counting.

## Phase 3 Key Lesson

In-memory state cannot be shared across processes. When you scale, every instance is an isolated island.

---

# Phase 4 — Distributed Rate Limiter with Redis

## What We Built

Both gateway instances share ONE Redis counter instead of separate in-memory Maps.

```
                     Redis (single source of truth)
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
   Gateway-1 (:3001)                Gateway-2 (:3002)
   INCR → Redis returns 3            INCR → Redis returns 4
   allowed                           allowed

   Next INCR → Redis returns 6 → BLOCKED (whichever gateway asks)
```

---

## Full Architecture

```
                      Client (curl)
                           │
              curl http://localhost:3000
                           │
                           ▼
                ┌────────────────────┐
                │   Load Balancer    │  :3000
                │   Round Robin      │
                └─────────┬──────────┘
                          │
         ┌────────────────┴────────────────┐
         │                                 │
         ▼                                 ▼
┌──────────────────┐              ┌──────────────────┐
│   Gateway 1      │              │   Gateway 2      │
│   Port 3001      │              │   Port 3002      │
└─────────┬────────┘              └─────────┬────────┘
          │                                 │
          └────────────────┬────────────────┘
                           ▼
                 ┌──────────────────┐
                 │      Redis       │  :6379
                 │  Shared Counter  │
                 └─────────┬────────┘
                           │
     ┌─────────────────────┼─────────────────────┐
     ▼                     ▼                     ▼
┌──────────┐        ┌──────────┐        ┌──────────┐
│  Users   │        │  Orders  │        │ Payments │
│  :4001   │        │  :4002   │        │  :4003   │
└──────────┘        └──────────┘        └──────────┘
```

---

## Files Added

```
src/
├── config/redis.ts
└── services/redisRateLimiter.ts

src/load-balancer/
├── index.ts
└── run-gateways.ts

services/
└── redis-mock-server.ts

docker-compose.yml
```

---

## src/config/redis.ts — Why It Exists

```typescript
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 100, 2000);  // exponential backoff
  },
  lazyConnect: true,
});
```

**Why shared client:** One persistent TCP connection reused for all commands.
**Why lazyConnect:** Don't crash on startup if Redis is not running yet.

---

## src/services/redisRateLimiter.ts — How It Works

```typescript
public async consume(clientId: string): Promise<RateLimitResult> {
  const key = `ratelimit:${clientId}`;  // "ratelimit:user:Alice"

  // 1. Atomically increment counter
  const currentCount = await this.redis.incr(key);

  // 2. On first request, start the 60-second window
  if (currentCount === 1) {
    await this.redis.expire(key, windowSeconds);
  }

  // 3. Get remaining seconds in the window
  let ttl = await this.redis.ttl(key);

  const allowed = currentCount <= this.maxRequests;
  return { allowed, remaining: Math.max(0, this.maxRequests - currentCount) };
}
```

### Why INCR and not GET then SET?

**Wrong — race condition:**
```
G1: GET → 4
G2: GET → 4     (same value! G2 read before G1 wrote)
G1: SET 5 → allowed
G2: SET 5 → allowed   BOTH got through at count 5!
```

**Right — atomic INCR:**
```
G1: INCR → Redis returns 5 → allowed
G2: INCR → Redis returns 6 → BLOCKED
```

Redis INCR is atomic. No two commands interleave. This is the core guarantee.

---

## src/load-balancer/index.ts — How It Works

```typescript
const gatewayPool = [
  { name: 'Gateway-1', url: 'http://localhost:3001' },
  { name: 'Gateway-2', url: 'http://localhost:3002' },
];

let currentIndex = 0;

function getNextGateway() {
  const target = gatewayPool[currentIndex];
  currentIndex = (currentIndex + 1) % gatewayPool.length;
  return target;
}

app.use((req, res, next) => {
  const chosenGateway = getNextGateway();
  res.setHeader('X-Served-By', chosenGateway.name);
  const proxy = createProxyMiddleware({ target: chosenGateway.url, changeOrigin: true });
  proxy(req, res, next);
});

app.listen(3000);
```

**Why round-robin:** Simplest algorithm. Distributes traffic evenly.
Req 1 to G1, Req 2 to G2, Req 3 to G1, Req 4 to G2...

**Why X-Served-By header:** Shows which gateway handled your request during testing.
Proves both instances share the same Redis counter.

---

## src/load-balancer/run-gateways.ts — Why It Exists

```typescript
for (const inst of instances) {
  spawn(process.execPath, [tsxCli, 'watch', serverScript], {
    env: { ...process.env, GATEWAY_PORT: inst.port },
    stdio: 'inherit',
  });
}
```

**Why:** Instead of 2 terminals, spawns both as child processes.
Key trick: `GATEWAY_PORT: inst.port` injects a different port per child process.
Same server.ts code, different port. Two gateway instances from one file.

---

## services/redis-mock-server.ts — Why It Exists

Redis is a standalone program — not an npm package.
To use real Redis you must install it or run Docker.

This file is a lightweight Redis substitute written in Node.js.
It speaks the exact RESP protocol over TCP on port 6379.
Real ioredis clients connect to it exactly as if it were real Redis.

```typescript
const server = net.createServer((socket) => {
  socket.on('data', (data) => {
    const commands = parseRESP(data);     // parse RESP text bytes
    for (const cmdArgs of commands) {
      if (cmd === 'INCR')   { /* increment Map, reply :3\r\n  */ }
      if (cmd === 'EXPIRE') { /* set expiry timestamp, reply :1\r\n */ }
      if (cmd === 'TTL')    { /* calc remaining seconds, reply :58\r\n */ }
    }
  });
});
server.listen(6379);
```

**Why not real Redis:** On Windows, Redis has no official native installer.
Docker Desktop may not always be running.
This mock lets you test distributed rate limiting instantly with zero prerequisites.

---

## docker-compose.yml — Why It Exists

```yaml
services:
  redis:
    image: redis:alpine
    ports:
      - '6379:6379'
```

If you have Docker, one command starts real Redis:
```bash
docker compose up -d redis
```

This is the production-grade option.
The mock server is for convenience without Docker.
You only need ONE of the two — not both.

---

# Full Request Flow Phase 4

**Command:** `curl http://localhost:3000/api/users/1 -H "x-user-id: Alice"`

```
curl
 │  opens TCP socket to :3000
 ▼
src/load-balancer/index.ts   (:3000)
  Express parses bytes
  req.method = "GET", req.url = "/api/users/1"
  getNextGateway() → Gateway-1 (http://localhost:3001)
  res.setHeader('X-Served-By', 'Gateway-1')
  createProxyMiddleware({ target: 'http://localhost:3001' })
  opens NEW TCP socket to :3001 and forwards request
 │
 │  NEW TCP socket to :3001
 ▼
src/server.ts   (:3001)
  app.listen(3001) owns this port
  imports app from app.ts, hands req/res to it
 │
 ▼
src/app.ts
  runs middleware in order:
    1. requestLogger
    2. rateLimiter
    3. gatewayRoutes
 │
 ▼
src/middleware/requestLogger.ts
  logs: [REQ] GET /api/users/1
  start = Date.now()
  registers res.on('finish') to log latency later
  next()  — immediately continues, does not block
 │
 ▼
src/middleware/rateLimiter.ts
  reads x-user-id header → clientId = "user:Alice"
  await rateLimiterService.consume("user:Alice")
  PAUSES — yields to event loop, waits for Redis
 │
 │  ioredis sends RESP bytes over TCP to :6379
 ▼
src/services/redisRateLimiter.ts
  key = "ratelimit:user:Alice"
  INCR   → currentCount = 3
  EXPIRE → set 60s TTL (only if count == 1)
  TTL    → 58 seconds remaining
  return { allowed: true, remaining: 2, limit: 5 }
 │
 │  TCP socket to :6379
 ▼
services/redis-mock-server.ts   (:6379)
  receives: *2\r\n$4\r\nINCR\r\n$22\r\nratelimit:user:Alice\r\n
  parseRESP → ["INCR", "ratelimit:user:Alice"]
  db.get("ratelimit:user:Alice") → { value: 2 }
  value becomes 3
  socket.write(":3\r\n")  — RESP integer reply
 │
 │  reply travels back to redisRateLimiter then rateLimiter
 ▼
src/middleware/rateLimiter.ts  (RESUMES)
  result.allowed = true  (3 <= 5)
  res.setHeader('X-RateLimit-Limit', '5')
  res.setHeader('X-RateLimit-Remaining', '2')
  next()  — continue to routes
 │
 ▼
src/gateway/routes.ts
  "/api/users/1" matches pathPrefix "/api/users"
  pathRewrite → "/users/1"
  calls createServiceProxy('http://localhost:4001', ...)
 │
 ▼
src/gateway/proxy.ts
  createProxyMiddleware({ target: 'http://localhost:4001', changeOrigin: true })
  opens NEW TCP socket to :4001
  rewrites Host header to "localhost:4001"
  sends: GET /users/1 HTTP/1.1
 │
 │  TCP socket to :4001
 ▼
services/user-service/index.ts   (:4001)
  Express matches GET /users/:id
  req.params.id = "1"
  finds { id: 1, name: "Alice", email: "alice@example.com" }
  res.json(user)
 │
 │  HTTP 200 response streams back in reverse
 ▼
proxy.ts → gateway → load-balancer → curl

res.on('finish') fires in requestLogger.ts
  prints: [RES] GET /api/users/1 -> 200 (OK, 14ms)
```

---

## HTTP on the Wire at Each Hop

**Hop 1 — curl to Load Balancer**
```
GET /api/users/1 HTTP/1.1
Host: localhost:3000
x-user-id: Alice
```

**Hop 2 — Load Balancer to Gateway-1**
```
GET /api/users/1 HTTP/1.1
Host: localhost:3001        changeOrigin rewrote this
x-user-id: Alice
X-Served-By: Gateway-1     Load Balancer added this
```

**Hop 3 — Gateway to User Service**
```
GET /users/1 HTTP/1.1       pathRewrite stripped /api prefix
Host: localhost:4001        changeOrigin rewrote this
x-user-id: Alice
X-RateLimit-Limit: 5        rateLimiter added these
X-RateLimit-Remaining: 2
```

**Redis RESP on the Wire (TCP :6379)**
```
Sent by ioredis:
*2\r\n$4\r\nINCR\r\n$22\r\nratelimit:user:Alice\r\n

Replied by Redis Mock:
:3\r\n
```

---

# File Purpose Reference

| File | Purpose |
|------|---------|
| `src/config/env.ts` | Single source of truth for all config |
| `src/config/redis.ts` | Shared ioredis client with reconnection |
| `src/server.ts` | Starts the HTTP server. Nothing else. |
| `src/app.ts` | Defines middleware order: logger → limiter → routes |
| `src/middleware/requestLogger.ts` | Logs requests and measures latency |
| `src/middleware/rateLimiter.ts` | Enforces rate limits, sets headers, blocks 429 |
| `src/services/rateLimitService.ts` | In-memory rate limiter (Phase 3, shows the flaw) |
| `src/services/redisRateLimiter.ts` | Distributed Redis rate limiter (Phase 4, the fix) |
| `src/gateway/routes.ts` | Maps path prefix to upstream service |
| `src/gateway/proxy.ts` | Opens TCP to upstream, rewrites path and host |
| `src/load-balancer/index.ts` | Round-robin load balancer on port 3000 |
| `src/load-balancer/run-gateways.ts` | Spawns 2 gateway instances on 3001 and 3002 |
| `services/user-service/index.ts` | Stub backend: user profiles on 4001 |
| `services/order-service/index.ts` | Stub backend: orders on 4002 |
| `services/payment-service/index.ts` | Stub backend: payments on 4003 |
| `services/run-all.ts` | Spawns all 3 backend services in one terminal |
| `services/redis-mock-server.ts` | RESP TCP server, replaces real Redis |
| `docker-compose.yml` | Starts real Redis via Docker (optional) |

---

# Phase 5 — Rate Limiting Algorithms: Fixed Window vs Sliding Window vs Token Bucket

In Phase 4, we used **Fixed Window** (`INCR` + `EXPIRE`). While simple and memory-efficient, Fixed Window has a critical vulnerability known as the **Boundary Spike Problem**.

### The Boundary Spike Flaw:
Suppose your limit is `5 requests per minute`:
- Client sends **5 requests at 00:59** (allowed, window 00:00 - 01:00).
- Window resets at 01:00.
- Client sends **5 requests at 01:01** (allowed, window 01:00 - 02:00).
- **Result**: The client successfully sent **10 requests in 2 seconds**! Your backend microservice experienced 2x the intended load.

To solve this, Phase 5 introduces three distinct algorithms swappable via the **Factory Pattern**.

```
                       RateLimiterFactory
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
     Fixed Window       Sliding Window       Token Bucket
    (Atomic INCR)        (Redis ZSET)        (Redis Hash)
   Fastest / O(1)      100% Precise         Burst-tolerant
```

---

## Algorithm 1 — Fixed Window
* **Redis Data Structure**: Redis String integer (`INCR ratelimit:<id>`)
* **How it works**:
  1. Increment key: `count = INCR key`.
  2. If `count === 1`, set expiry: `EXPIRE key windowSeconds`.
  3. If `count > limit`, block with HTTP 429.
* **Pros**: $O(1)$ memory and time complexity. Negligible Redis overhead.
* **Cons**: Vulnerable to 2x boundary spikes at window transitions.

---

## Algorithm 2 — Sliding Window Log
* **Redis Data Structure**: Redis Sorted Set (`ZSET`)
* **How it works**:
  Instead of a counter, every request timestamp is saved as a member in a Redis Sorted Set:
  1. Remove expired timestamps: `ZREMRANGEBYSCORE key 0 (now - windowMs)`.
  2. Count valid requests in current rolling window: `count = ZCARD key`.
  3. If `count < limit`:
     - Record current request: `ZADD key now (now + randomUUID)`.
     - Refresh TTL: `EXPIRE key windowSeconds`.
     - Allow request!
  4. If `count >= limit`:
     - Block with HTTP 429! Calculate `Retry-After` from oldest timestamp in set.
* **Pros**: 100% mathematically accurate. Zero boundary bursts.
* **Cons**: Higher memory consumption since every request timestamp is stored.

---

## Algorithm 3 — Token Bucket
* **Redis Data Structure**: Redis Hash (`HMGET` / `HSET`) storing `{ tokens, lastRefillTime }`.
* **How it works**:
  The bucket has a capacity `maxRequests` and refills continuously at `refillRate = maxRequests / windowSeconds` tokens per second.
  1. Read state: `tokens, lastRefill = HMGET key tokens lastRefillTime`.
  2. **Lazy Refill Equation**:
     $$\text{tokens} = \min(\text{capacity}, \text{currentTokens} + \Delta t \times \text{refillRate})$$
  3. If `tokens >= 1`:
     - Decrement: `tokens = tokens - 1`.
     - Save state: `HSET key tokens newTokens lastRefillTime now`.
     - Allow request!
  4. If `tokens < 1`:
     - Block with HTTP 429!
* **Pros**: Supports controlled traffic bursts (e.g., initial page load pulling 5 assets at once) while strictly enforcing average rate over time.
* **Cons**: Slightly more complex arithmetic calculation.

---

## The Factory Pattern: Hot-Swappable via Env Var

```typescript
// src/services/rateLimiterFactory.ts
export function createRateLimiter(
  algorithm: 'fixed-window' | 'sliding-window' | 'token-bucket',
  redis: Redis,
  windowMs: number,
  maxRequests: number
) { ... }
```

You can toggle algorithms instantly without modifying a single line of code:
```bash
RATE_LIMIT_ALGORITHM=sliding-window npm run dev:gateway
RATE_LIMIT_ALGORITHM=token-bucket   npm run dev:gateway
RATE_LIMIT_ALGORITHM=fixed-window   npm run dev:gateway
```

---

## Comparing All 3 in Action

Run the benchmark test:
```bash
npm run test:algorithms
```

---

# Phase 6 — Reliability: Timeout, Retry + Backoff, and Circuit Breaker

In production distributed systems, microservices fail, hang, restart, and suffer transient hiccups.
Without a reliability shield, one failing downstream service creates a **cascading failure** that takes down the entire API Gateway.

```
Client Request
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway Pipeline                     │
│                                                             │
│  1. Circuit Breaker Check                                   │
│     - State OPEN? ──► Fast-fail (503 Service Unavailable)  │
│                       <1ms latency, 0 upstream traffic!     │
│                                                             │
│  2. Retry Loop with Exponential Backoff + Jitter            │
│     - Attempt 1: Upstream call                              │
│       └─ Wrapped in Timeout (e.g. 3000ms ──► 504)           │
│     - Transient 5xx / Network drop?                         │
│       └─ Wait backoff (100ms -> 200ms -> 400ms + Jitter)    │
│       └─ Retry attempt 2, 3...                              │
│                                                             │
│  3. Circuit Breaker Feedback                                │
│     - Success: Record success (heals HALF-OPEN -> CLOSED)   │
│     - Repeated Failures: Trip CLOSED -> OPEN                │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
Upstream Microservice (:4001, :4002, :4003)
```

---

## Pillar 1 — Timeout (Avoid Cascading Sockets Starvation)

* **Problem**: An upstream service hangs on a deadlocked query or slow external dependency. The gateway keeps the client TCP socket open waiting forever. Soon all gateway sockets and threads are consumed, and the gateway crashes.
* **Solution**: `withTimeout` with `AbortController`. If upstream does not respond within `PROXY_TIMEOUT_MS` (e.g. 3000ms), the gateway aborts the connection and immediately returns **504 Gateway Timeout**.

---

## Pillar 2 — Retry + Exponential Backoff with Jitter

* **Problem**: Microservices experience brief transient network drops or temporary restarts. Failing immediately ruins user experience. But retrying immediately hammers an already struggling server ("Thundering Herd").
* **Solution**:
  1. Only retry **idempotent** methods (GET, HEAD, PUT, DELETE, OPTIONS). Never retry a non-idempotent POST (e.g. charge payment) unless idempotency keys are used.
  2. Retry on transient server errors (HTTP 500, 502, 503, 504, ECONNREFUSED).
  3. Wait with **Exponential Backoff**: `min(maxDelay, initialDelay * 2^(attempt-1))`.
  4. Add random **Jitter** (0-50ms) to desynchronize concurrent retries so they do not hit the server at the exact same millisecond.

---

## Pillar 3 — Circuit Breaker (Fast-Fail and Self-Healing)

```
        ┌────────────────────────────────────────────────────────┐
        │                                                        │
        ▼                                                        │
    ┌────────┐  Consecutive Failures >= 5  ┌────────┐  Cooldown  │ Probe
    │ CLOSED │ ──────────────────────────> │  OPEN  │ ────────┐  │ Succeeded
    └────────┘                             └────────┘         │  │
        ▲                                                     ▼  │
        │                                                ┌───────────┐
        └────────────────────────────────────────────────┤ HALF-OPEN │
                           Probe Failed                  └───────────┘
                         (trip back to OPEN) ───────────────▲
```

1. **CLOSED**:
   - Normal operation. Requests flow to the microservice.
   - Failures increment consecutive failure counter. Successes reset it.
   - If failures >= `failureThreshold` (default 5) ➔ Transitions to **OPEN**.
2. **OPEN**:
   - Upstream service is down.
   - Incoming requests are **fast-failed in < 2ms** with `503 Service Unavailable`.
   - **Zero network requests** are sent to the upstream service. This shields the gateway and gives the microservice quiet room to recover.
   - Cooldown timer starts (`resetTimeoutMs`, default 10s).
3. **HALF-OPEN**:
   - Cooldown elapsed. The gateway allows a trial **probe request** through.
   - If probe succeeds ➔ Upstream is healthy! Transitions to **CLOSED**.
   - If probe fails ➔ Upstream is still broken. Trips back to **OPEN** for another cooldown.

---

## Files Added in Phase 6

| File | Purpose |
|------|---------|
| [`src/reliability/types.ts`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/src/reliability/types.ts) | Types and interfaces for Circuit Breakers, Retries, and Timeouts |
| [`src/reliability/timeout.ts`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/src/reliability/timeout.ts) | `withTimeout` wrapper using `AbortController` and `TimeoutError` (504) |
| [`src/reliability/retry.ts`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/src/reliability/retry.ts) | `executeWithRetry` with exponential backoff, jitter, and idempotency guards |
| [`src/reliability/circuitBreaker.ts`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/src/reliability/circuitBreaker.ts) | 3-state state machine (`CLOSED`, `OPEN`, `HALF-OPEN`) and per-service registry |
| [`src/reliability/reliableProxy.ts`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/src/reliability/reliableProxy.ts) | Unifies CB, Retries, and Timeouts into an Express proxy middleware |
| [`tests/phase6-reliability.test.ts`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/tests/phase6-reliability.test.ts) | Automated test suite verifying all 3 pillars |

---

---

# Phase 7 — Docker Full Ecosystem Setup ⭐

Phase 7 packages the entire distributed ecosystem into a single unified Docker Compose configuration.

```
                   Docker Network (gateway-net)
                               │
            ┌──────────────────┴──────────────────┐
            │                                     │
      Load Balancer                             Redis
         :3000                                  :6379
            │                               (Distributed Quota)
      ┌─────┴─────┐
      │           │
  Gateway 1   Gateway 2
    :3001       :3002
      │           │
      └─────┬─────┘
            │
     ┌──────┼──────────────┐
     ▼      ▼              ▼
   User   Order         Payment
  Service Service       Service
  (:4001) (:4002)       (:4003)
```

### Running with Docker Compose
```bash
# Build and start all 9 containers (Load Balancer, 2 Gateways, 3 Services, Redis, Prometheus, Grafana):
npm run docker:up

# Stop all containers:
npm run docker:down
```

---

# Phase 8 — Observability: Structured Logging, Prometheus & Grafana 📊

Production API gateways handle thousands of requests per second. When something fails or slows down, you cannot grep through chaotic text. You need **Correlation IDs**, **Structured Key-Value Logs**, and **Metrics Scraped by Prometheus into Grafana**.

```
Client Request
      │
      ├──> [Load Balancer :3000] ──► Injects X-Request-Id: abc123
      │
      └──> [Gateway 1 / Gateway 2]
                 │
                 ├──► Structured Log:
                 │    requestId=abc123 method=GET path=/api/users gateway=Gateway-1 status=200 duration=42ms
                 │
                 └──► Prometheus Metrics Registry:
                            │ (Exposed on /metrics)
                            ▼
                     [Prometheus :9090] (Scrapes every 5s)
                            │
                            ▼
                     [Grafana :3005] (Live visual dashboard)
```

## 1. Structured Logging & Distributed Tracing
* **X-Request-Id Propagation**: If a client provides `X-Request-Id`, the gateway preserves it. Otherwise, the gateway generates a UUID and passes it downstream to microservices and back to the client.
* **Standard Format**:
  ```text
  requestId=d3615132-06e3-4bd6-8a7b-9982ea2c9e68 method=GET path=/api/users gateway=Gateway-1 status=200 duration=15ms
  ```

## 2. Prometheus Metrics Exposition (`GET /metrics`)
Exposed in standard Prometheus text format:
* `requests_total{method, route, status, gateway}` (Counter)
* `requests_failed{service, reason}` (Counter)
* `rate_limit_rejected{client_id, algorithm}` (Counter)
* `request_duration_ms_bucket{gateway, le}` (Histogram: 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1000ms...)
* `upstream_errors{service, status}` (Counter)
* `upstream_timeouts{service}` (Counter)
* `circuit_breaker_state{service}` (Gauge: 0=CLOSED, 1=HALF-OPEN, 2=OPEN)

## 3. Grafana Dashboard (Pre-Provisioned)
Located at `http://localhost:3005` (Credentials: `admin / admin`).
Pre-loaded with `docker/grafana/dashboards/gateway-overview.json`:
- Traffic Rate (req/sec) per Gateway
- Status Code Distribution (200 OK vs 429 vs 5xx)
- Rate Limit Blocks Counter
- Circuit Breaker Status Gauges (Green = CLOSED, Yellow = HALF-OPEN, Red = OPEN)
- Latency Percentiles (P50, P95, P99)

---

## Files Added in Phase 7 & Phase 8

| File | Purpose |
|------|---------|
| [`Dockerfile`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/Dockerfile) | Multi-service Node 20 container image |
| [`docker-compose.yml`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/docker-compose.yml) | Complete stack: LB, Gateways, Backends, Redis, Prometheus, Grafana |
| [`src/observability/metrics.ts`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/src/observability/metrics.ts) | Prometheus metrics registry (counters, histograms, gauges) |
| [`docker/prometheus/prometheus.yml`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/docker/prometheus/prometheus.yml) | Prometheus scrape config targeting `:3001/metrics` and `:3002/metrics` |
| [`docker/grafana/`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/docker/grafana/) | Datasource & Dashboard automated provisioning |
| [`tests/phase8-observability.test.ts`](file:///d:/Learn_Programs/Projects/Distributed_Rate_Limiter_&_API_Gateway_Proxy/tests/phase8-observability.test.ts) | Observability test verifying logging, request IDs, and `/metrics` |

---

## Key Concepts Glossary

| Term | What it means |
|------|--------------|
| TCP Socket | A reliable byte pipe between two processes. HTTP is text riding on top. |
| RESP | Redis Serialization Protocol. The text format Redis uses over TCP. |
| Middleware | Function that receives req, res, next. Calls next() to continue or sends response to stop. |
| app.use() | Registers a middleware. Runs in the order registered. |
| next() | Tells Express to run the next middleware in the chain. |
| changeOrigin | Rewrites the Host header to match the upstream server address. |
| pathRewrite | Regex-replaces URL path prefix before forwarding. /api/users/1 becomes /users/1. |
| Streaming | Bytes flow chunk by chunk through the proxy without buffering the whole body in RAM. |
| await | Suspends an async function and yields to the event loop until a Promise resolves. |
| res.on('finish') | Event fires after all response bytes are flushed to the client TCP socket. |
| Round-Robin | Distribute requests evenly: 1 to G1, 2 to G2, 3 to G1, 4 to G2... |
| INCR Redis | Atomically increments an integer key. Cannot be interrupted by another command. |
| EXPIRE Redis | Sets a TTL on a key. Key auto-deletes when time runs out. |
| TTL Redis | Time To Live. How many seconds until a key expires. |
| Fail-open | If Redis is unreachable, allow the request through instead of blocking everyone. |
| Atomic | An operation that cannot be split. Either fully done or not done at all. |
| Race condition | Two concurrent operations interfere because neither knows about the other's changes. |
| Timeout (504) | Aborting an upstream call that took too long, freeing gateway resources immediately. |
| Exponential Backoff | Progressively increasing delay between retries (e.g. 100ms -> 200ms -> 400ms) to allow service recovery. |
| Jitter | Random millisecond offset added to retry delays to prevent concurrent requests from syncing (Thundering Herd). |
| Circuit Breaker | Safety state machine (CLOSED/OPEN/HALF-OPEN) that fast-fails calls to dead services without network traffic. |
| Fast-Fail | Returning an immediate error (HTTP 503 in <2ms) without making network calls when a service is known down. |
| Idempotency | An operation that produces the same state regardless of how many times it is run (GET, PUT, DELETE). |
| Correlation ID | A unique UUID (`X-Request-Id`) attached to a request so it can be traced across multiple microservices. |
| Prometheus | Pull-based timeseries monitoring system that scrapes `/metrics` endpoints at fixed intervals. |
| Grafana | Visualization dashboard UI that queries Prometheus and displays real-time graphs and alerts. |

---

## Roadmap

- [x] Phase 1 — Basic HTTP Proxy
- [x] Phase 2 — Multi-Service Routing
- [x] Phase 3 — In-Memory Rate Limiter + Multi-Instance Flaw Demo
- [x] Phase 4 — Distributed Rate Limiter with Redis
- [x] Phase 5 — Rate Limit Algorithms: Fixed Window vs Sliding Window vs Token Bucket
- [x] Phase 6 — Reliability: Timeout (504), Retry + Backoff, and Circuit Breaker
- [x] Phase 7 — Docker Full Setup (Complete Compose Stack)
- [x] Phase 8 — Observability: Structured Logging + Prometheus & Grafana

