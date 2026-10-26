# Distributed Rate Limiter & Resilient API Gateway Proxy

> A high-performance, fault-tolerant **API Gateway and Distributed Rate Limiting System** built from scratch in TypeScript and Node.js. Incorporates distributed state synchronization with Redis, three industry-standard rate limiting algorithms, a resilience suite (Circuit Breakers, Retries with Backoff, and Timeouts), and full observability with Prometheus and Grafana.

---

## System Architecture

```
                                  Client Request
                                        │
                           http://localhost:3000/api/users/1
                                        │
                                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                  INGRESS: LOAD BALANCER (:3000)                              │
│         • Injects / propagates correlation ID: X-Request-Id: <UUID>          │
│         • Round-Robin distribution across gateway instances                  │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                ┌───────────────────────┴───────────────────────┐
                │ (Req 1, 3, 5...)                              │ (Req 2, 4, 6...)
                ▼                                               ▼
┌───────────────────────────────┐               ┌───────────────────────────────┐
│       GATEWAY 1 (:3001)       │               │       GATEWAY 2 (:3002)       │
│  • Distributed Rate Limiting  │               │  • Distributed Rate Limiting  │
│  • Circuit Breaker (3-State)  │               │  • Circuit Breaker (3-State)  │
│  • Idempotent Retries + Jitter│               │  • Idempotent Retries + Jitter│
│  • AbortController Timeout    │               │  • AbortController Timeout    │
│  • Structured Logger          │               │  • Structured Logger          │
│  • GET /metrics (Prometheus)  │               │  • GET /metrics (Prometheus)  │
└───────────────┬───────────────┘               └───────────────┬───────────────┘
                │                                               │
                ├───────────────────────┬───────────────────────┤
                │                       │                       │
                ▼                       ▼                       ▼
   ┌─────────────────────────┐  ┌──────────────┐         ┌──────────────┐
   │       REDIS (:6379)     │  │ USER SERVICE │         │ORDER SERVICE │
   │   Shared Atomic Quota   │  │   (:4001)    │         │   (:4002)    │
   └─────────────────────────┘  └──────────────┘         └──────────────┘
                                       │                        │
                                       └───────────┬────────────┘
                                                   ▼
                                        ┌──────────────────────┐
                                        │   PAYMENT SERVICE    │
                                        │       (:4003)        │
                                        └──────────────────────┘

═════════════════════════════ OBSERVABILITY LAYER ════════════════════════════
                        Gateway 1 (:3001) & Gateway 2 (:3002)
                                       │
                                       ▼ (Scrapes /metrics every 5s)
                            ┌─────────────────────┐
                            │  PROMETHEUS (:9090) │
                            └──────────┬──────────┘
                                       │ (Datasource)
                                       ▼
                            ┌─────────────────────┐
                            │   GRAFANA (:3005)   │
                            │  Pre-Built Dashboard│
                            └─────────────────────┘
```

---

## Key Engineering Highlights

### 1. Ingress & Load Balancing
- **Round-Robin Load Balancer (`:3000`)**: Distributes client traffic evenly across horizontally scaled gateway instances (`:3001` and `:3002`).
- **Distributed Trace Propagation**: Attaches a unique correlation ID (`X-Request-Id`) across the load balancer, gateways, and backend microservices.

### 2. Distributed Rate Limiting
- **Shared Redis Store (`:6379`)**: Prevents the multi-instance flaw where clients could double their quota by sending requests to different gateway instances.
- **Factory Pattern with 3 Interchangeable Algorithms**:
  - **Fixed Window** (`INCR` + `EXPIRE`): Ultra-fast, minimal memory footprint.
  - **Sliding Window Log** (Redis `ZSET`): Precision sliding window tracking exact request timestamps (`ZADD`, `ZREMRANGEBYSCORE`, `ZCARD`).
  - **Token Bucket** (Redis Hash): Lazy refill equation allowing bursts while maintaining steady continuous rate.
  - Swappable dynamically via environment variable: `RATE_LIMIT_ALGORITHM=sliding-window`.

### 3. Reliability Shield (Phase 6)
- **Timeout Protection**: Strict request deadlines via native `AbortController`. Hanging upstreams abort at 3000ms, returning `HTTP 504 Gateway Timeout` and freeing sockets immediately.
- **Idempotent Retry with Exponential Backoff + Jitter**: Automatic retries for transient errors (500, 502, 503, 504, connection drops) with backoff (`delay * 2^attempt + jitter`). Safely restricted to idempotent methods (`GET`, `PUT`, `DELETE`, `OPTIONS`).
- **Circuit Breaker (State Machine)**:
  - `CLOSED`: Normal traffic. Failures increment counter; successes reset it.
  - `OPEN`: Trips after 5 consecutive failures. **Fast-fails incoming traffic in < 2ms** with `HTTP 503 Service Unavailable`, protecting both gateway resources and struggling services.
  - `HALF-OPEN`: After a 10s cooldown, allows a single probe request. Success resets to `CLOSED`; failure trips back to `OPEN`.
- **Bulkhead Isolation**: Independent circuit breakers per service (`user-service`, `order-service`, `payment-service`). A failure in payments never degrades user auth.

### 4. Observability & Monitoring (Phase 8)
- **Structured JSON-like Logging**: `requestId=... method=... path=... gateway=... status=... duration=...ms`
- **Prometheus Metrics (`GET /metrics`)**: Native exposition format tracking `requests_total`, `request_duration_ms` (histograms), `rate_limit_rejected`, `upstream_timeouts`, `upstream_errors`, and `circuit_breaker_state`.
- **Pre-Provisioned Grafana Dashboard (`:3005`)**: Auto-loads real-time graphs for request rates, status codes, p95/p99 latency, rate limit rejections, and circuit breaker status.

---

## Quick Start with Docker (Recommended)

Start the entire 9-container cluster with a single command:

```bash
# 1. Build and boot all containers in the background:
npm run docker:up

# 2. Stream live structured logs from the gateways:
npm run docker:logs

# 3. Stop all containers:
npm run docker:down
```

### Exposed Host Ports:
| Service | URL | Role |
| :--- | :--- | :--- |
| **Public API Gateway** | `http://localhost:3000` | Single public entry point |
| **Gateway 1 (Direct)** | `http://localhost:3001` | Gateway Node 1 (`/metrics`, `/health`) |
| **Gateway 2 (Direct)** | `http://localhost:3002` | Gateway Node 2 (`/metrics`, `/health`) |
| **Prometheus UI** | `http://localhost:9090` | Metrics queries and target health |
| **Grafana Dashboard** | `http://localhost:3005` | Real-time graphs (Login: `admin` / `admin`) |
| **Redis** | `localhost:6379` | Distributed quota store |
| **User Service** | `http://localhost:4001` | Microservice |
| **Order Service** | `http://localhost:4002` | Microservice |
| **Payment Service** | `http://localhost:4003` | Microservice |

---

## Local Development (Without Docker)

You can also run all services directly on your host machine:

```bash
# Terminal 1: Standalone RESP Redis Mock
npm run dev:redis

# Terminal 2: Upstream Microservices
npm run dev:services

# Terminal 3: Gateway Nodes (:3001, :3002)
npm run dev:gateways

# Terminal 4: Load Balancer (:3000)
npm run dev:lb
```

---

## API Route Catalog

### Gateway Infrastructure
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/lb-status` | Load Balancer health & active node pool |
| `GET` | `/health` | Gateway health check & routing table |
| `GET` | `/health/circuit-breakers` | Live circuit breaker stats & states for all services |
| `GET` | `/metrics` | Prometheus metrics exposition endpoint |

### Upstream Microservices (via Gateway `:3000`)
| Method | Endpoint | Target Service |
| :--- | :--- | :--- |
| `GET` | `/api/users` | List all users |
| `GET` | `/api/users/:id` | Get user profile (`/api/users/1`) |
| `POST` | `/api/users` | Create user profile |
| `GET` | `/api/orders` | List orders (supports `?userId=1`) |
| `GET` | `/api/orders/:id` | Get order details |
| `POST` | `/api/orders` | Create an order |
| `GET` | `/api/payments` | List payments (supports `?orderId=101`) |
| `GET` | `/api/payments/:id`| Get payment details |
| `POST` | `/api/payments` | Process payment |

### Chaos & Reliability Simulation Endpoints
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/users/simulate/delay?ms=5000` | Simulates slow upstream (Triggers 504 Timeout) |
| `GET` | `/api/users/simulate/flaky?failTimes=2` | Fails first 2 attempts with 503, succeeds on 3rd attempt |
| `GET` | `/api/users/simulate/unstable` | Simulates crashing upstream (Triggers Circuit Breaker OPEN) |
| `POST` | `:4001/users/simulate/toggle-crash` | Toggles crash mode (`{"crashing": true/false}`) on User Service |

---

## Test Suites

The project includes isolated, fully automated verification suites:

```bash
# 1. Test Distributed Redis Rate Limiting across multi-gateway setup
npm run test:redis

# 2. Compare Rate Limiting Algorithms (Fixed vs Sliding Window vs Token Bucket)
npm run test:algorithms

# 3. Test Reliability Suite (Timeouts, Retries + Backoff, Circuit Breaker State Machine)
npm run test:reliability

# 4. Test Observability (Trace Propagation, Structured Logs, Prometheus Exposition)
npm run test:observability
```

---

## Project Structure

```
├── Dockerfile                  # Production container image
├── docker-compose.yml          # Full 9-service ecosystem stack
├── docker/
│   ├── prometheus/             # Prometheus scrape configuration
│   └── grafana/                # Grafana datasource & dashboard provisioning
├── src/
│   ├── config/                 # Central environment & Redis configuration
│   ├── gateway/                # Routing tables & proxy forwarder
│   ├── load-balancer/          # Round-robin load balancer & multi-node runner
│   ├── middleware/             # Rate limiter & structured logger middlewares
│   ├── observability/          # Prometheus Metrics Registry (Counters, Histograms, Gauges)
│   ├── reliability/            # Circuit Breaker, Retries + Backoff, Timeout wrapper
│   ├── services/               # Fixed Window, Sliding Window, and Token Bucket limiters
│   ├── app.ts                  # Express application pipeline
│   └── server.ts               # Gateway server entry point
├── services/                   # Independent backend microservices (Users, Orders, Payments)
└── tests/                      # Automated test & benchmark suites
```

---

## Step-by-Step Architecture Journey

For a deep-dive explanation of every architectural decision, flaw demonstration, and benchmark, see [JOURNEY.md](JOURNEY.md).

---

## License

ISC License
