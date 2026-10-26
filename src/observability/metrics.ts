// src/observability/metrics.ts
//
// Phase 8: Prometheus Metrics Registry
//
// Tracks core API Gateway metrics and formats them in the standard
// Prometheus text exposition format (text/plain; version=0.0.4).
//
// Metrics tracked:
//   - requests_total          (counter, labels: method, route, status, gateway)
//   - requests_failed         (counter, labels: service, reason)
//   - rate_limit_rejected     (counter, labels: client_id, algorithm)
//   - request_duration_ms     (histogram with buckets: 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000)
//   - upstream_errors         (counter, labels: service, status)
//   - upstream_timeouts       (counter, labels: service)
//   - circuit_breaker_state   (gauge: 0=CLOSED, 1=HALF-OPEN, 2=OPEN, labels: service)

interface LabelSet {
  [key: string]: string | number;
}

function formatLabels(labels: LabelSet): string {
  const entries = Object.entries(labels).filter(([_, v]) => v !== undefined);
  if (entries.length === 0) return '';
  const formatted = entries
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join(',');
  return `{${formatted}}`;
}

class Counter {
  private values = new Map<string, number>();

  inc(labels: LabelSet = {}, value = 1): void {
    const key = JSON.stringify(labels);
    const current = this.values.get(key) ?? 0;
    this.values.set(key, current + value);
  }

  get(labels: LabelSet = {}): number {
    return this.values.get(JSON.stringify(labels)) ?? 0;
  }

  export(metricName: string): string[] {
    const lines: string[] = [];
    for (const [key, val] of this.values.entries()) {
      const labels = JSON.parse(key) as LabelSet;
      lines.push(`${metricName}${formatLabels(labels)} ${val}`);
    }
    return lines;
  }

  reset(): void {
    this.values.clear();
  }
}

class Gauge {
  private values = new Map<string, number>();

  set(labels: LabelSet, value: number): void {
    this.values.set(JSON.stringify(labels), value);
  }

  get(labels: LabelSet): number {
    return this.values.get(JSON.stringify(labels)) ?? 0;
  }

  export(metricName: string): string[] {
    const lines: string[] = [];
    for (const [key, val] of this.values.entries()) {
      const labels = JSON.parse(key) as LabelSet;
      lines.push(`${metricName}${formatLabels(labels)} ${val}`);
    }
    return lines;
  }

  reset(): void {
    this.values.clear();
  }
}

class Histogram {
  public readonly buckets: number[];
  private bucketCounts = new Map<string, Map<number, number>>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();

  constructor(buckets: number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: LabelSet, value: number): void {
    const key = JSON.stringify(labels);

    // Update sum and count
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);

    // Update bucket counts
    let bMap = this.bucketCounts.get(key);
    if (!bMap) {
      bMap = new Map();
      this.bucketCounts.set(key, bMap);
    }

    for (const b of this.buckets) {
      if (value <= b) {
        bMap.set(b, (bMap.get(b) ?? 0) + 1);
      }
    }
  }

  export(metricName: string): string[] {
    const lines: string[] = [];
    for (const [key, count] of this.counts.entries()) {
      const labels = JSON.parse(key) as LabelSet;
      const bMap = this.bucketCounts.get(key) ?? new Map();
      const sum = this.sums.get(key) ?? 0;

      for (const b of this.buckets) {
        const bCount = bMap.get(b) ?? 0;
        lines.push(`${metricName}_bucket${formatLabels({ ...labels, le: b })} ${bCount}`);
      }
      lines.push(`${metricName}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${metricName}_sum${formatLabels(labels)} ${sum}`);
      lines.push(`${metricName}_count${formatLabels(labels)} ${count}`);
    }
    return lines;
  }

  reset(): void {
    this.bucketCounts.clear();
    this.sums.clear();
    this.counts.clear();
  }
}

export class MetricsRegistry {
  public readonly requestsTotal = new Counter();
  public readonly requestsFailed = new Counter();
  public readonly rateLimitRejected = new Counter();
  public readonly requestDuration = new Histogram([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);
  public readonly upstreamErrors = new Counter();
  public readonly upstreamTimeouts = new Counter();
  public readonly circuitBreakerState = new Gauge();

  /**
   * Records completed request metrics
   */
  public recordRequest(
    method: string,
    route: string,
    status: number,
    durationMs: number,
    gateway: string
  ): void {
    // Normalize route to avoid high-cardinality explosions (e.g. /api/users/123 -> /api/users/:id)
    const normalizedRoute = route.split('?')[0].replace(/\/\d+/g, '/:id');

    this.requestsTotal.inc({
      method: method.toUpperCase(),
      route: normalizedRoute,
      status: String(status),
      gateway,
    });

    this.requestDuration.observe({ gateway }, durationMs);
  }

  public recordRateLimitRejection(clientId: string, algorithm: string): void {
    this.rateLimitRejected.inc({ client_id: clientId, algorithm });
  }

  public recordUpstreamError(service: string, status: number): void {
    this.upstreamErrors.inc({ service, status: String(status) });
  }

  public recordUpstreamTimeout(service: string): void {
    this.upstreamTimeouts.inc({ service });
  }

  public recordFailedRequest(service: string, reason: string): void {
    this.requestsFailed.inc({ service, reason });
  }

  public updateCircuitBreakerState(
    service: string,
    state: 'CLOSED' | 'HALF-OPEN' | 'OPEN'
  ): void {
    // 0 = CLOSED (healthy), 1 = HALF-OPEN (testing probe), 2 = OPEN (tripped / fast-fail)
    const val = state === 'CLOSED' ? 0 : state === 'HALF-OPEN' ? 1 : 2;
    this.circuitBreakerState.set({ service }, val);
  }

  /**
   * Generates standard Prometheus exposition text format.
   */
  public getPrometheusMetrics(): string {
    const lines: string[] = [];

    // requests_total
    lines.push('# HELP requests_total Total number of incoming HTTP requests');
    lines.push('# TYPE requests_total counter');
    lines.push(...this.requestsTotal.export('requests_total'));
    lines.push('');

    // requests_failed
    lines.push('# HELP requests_failed Total number of failed requests');
    lines.push('# TYPE requests_failed counter');
    lines.push(...this.requestsFailed.export('requests_failed'));
    lines.push('');

    // rate_limit_rejected
    lines.push('# HELP rate_limit_rejected Total requests rejected by rate limiters (HTTP 429)');
    lines.push('# TYPE rate_limit_rejected counter');
    lines.push(...this.rateLimitRejected.export('rate_limit_rejected'));
    lines.push('');

    // request_duration_ms
    lines.push('# HELP request_duration_ms Request latency histogram in milliseconds');
    lines.push('# TYPE request_duration_ms histogram');
    lines.push(...this.requestDuration.export('request_duration_ms'));
    lines.push('');

    // upstream_errors
    lines.push('# HELP upstream_errors Total 5xx errors returned from upstream services');
    lines.push('# TYPE upstream_errors counter');
    lines.push(...this.upstreamErrors.export('upstream_errors'));
    lines.push('');

    // upstream_timeouts
    lines.push('# HELP upstream_timeouts Total requests that timed out waiting for upstream');
    lines.push('# TYPE upstream_timeouts counter');
    lines.push(...this.upstreamTimeouts.export('upstream_timeouts'));
    lines.push('');

    // circuit_breaker_state
    lines.push('# HELP circuit_breaker_state State of circuit breaker (0=CLOSED, 1=HALF-OPEN, 2=OPEN)');
    lines.push('# TYPE circuit_breaker_state gauge');
    lines.push(...this.circuitBreakerState.export('circuit_breaker_state'));
    lines.push('');

    return lines.join('\n');
  }

  public reset(): void {
    this.requestsTotal.reset();
    this.requestsFailed.reset();
    this.rateLimitRejected.reset();
    this.requestDuration.reset();
    this.upstreamErrors.reset();
    this.upstreamTimeouts.reset();
    this.circuitBreakerState.reset();
  }
}

export const metricsRegistry = new MetricsRegistry();
