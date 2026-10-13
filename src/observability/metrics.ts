/**
 * Minimal in-process Prometheus registry for the generation core (PRD §21.3).
 *
 * Scope: the Phase 2 metric subset. Counters/gauges are integers or floats; histograms keep a
 * fixed bucket set and expose `_bucket`/`_sum`/`_count`. Labels are **low-cardinality only** —
 * never `userId`, never message ids (PRD §21.3). The `/metrics` route renders this.
 *
 * This is intentionally hand-rolled (no prom-client): the surface is tiny, and the existing
 * `/metrics` route already emits the `aichat_` prefix.
 */

export type Labels = Readonly<Record<string, string>>;

interface CounterMetric {
  readonly kind: 'counter';
  readonly help: string;
  readonly values: Map<string, number>;
  readonly labelNames: readonly string[];
}

interface GaugeMetric {
  readonly kind: 'gauge';
  readonly help: string;
  readonly values: Map<string, number>;
  readonly labelNames: readonly string[];
}

interface HistogramMetric {
  readonly kind: 'histogram';
  readonly help: string;
  readonly buckets: readonly number[];
  readonly labelNames: readonly string[];
  /** key → [bucketCounts..., sum, count] */
  readonly values: Map<string, { counts: number[]; sum: number; count: number }>;
}

type Metric = CounterMetric | GaugeMetric | HistogramMetric;

const DEFAULT_BUCKETS = [
  0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120,
] as const;

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    const metric: CounterMetric = { kind: 'counter', help, labelNames, values: new Map() };
    this.metrics.set(name, metric);
    return new Counter(metric);
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    const metric: GaugeMetric = { kind: 'gauge', help, labelNames, values: new Map() };
    this.metrics.set(name, metric);
    return new Gauge(metric);
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = DEFAULT_BUCKETS,
  ): Histogram {
    const metric: HistogramMetric = { kind: 'histogram', help, labelNames, buckets, values: new Map() };
    this.metrics.set(name, metric);
    return new Histogram(metric);
  }

  /** Render every metric in the Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const [name, metric] of this.metrics) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} ${metric.kind}`);
      if (metric.kind === 'histogram') {
        for (const [key, value] of metric.values) {
          const labels = key;
          let cumulative = 0;
          metric.buckets.forEach((bound, index) => {
            cumulative += value.counts[index] ?? 0;
            lines.push(
              `${name}_bucket${labelled(labels, 'le', String(bound))} ${cumulative}`,
            );
          });
          const total = cumulative + (value.counts[metric.buckets.length] ?? 0);
          lines.push(`${name}_bucket${labelled(labels, 'le', '+Inf')} ${total}`);
          lines.push(`${name}_sum${labels} ${value.sum}`);
          lines.push(`${name}_count${labels} ${value.count}`);
        }
      } else {
        for (const [labels, value] of metric.values) {
          lines.push(`${name}${labels} ${value}`);
        }
      }
    }
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
  }

  /** Test helper: drop all series (metric definitions stay registered). */
  reset(): void {
    for (const metric of this.metrics.values()) metric.values.clear();
  }
}

function labelled(existing: string, name: string, value: string): string {
  return existing === '' ? `{${name}="${value}"}` : `${existing.slice(0, -1)},${name}="${value}"}`;
}

function keyOf(labelNames: readonly string[], labels: Labels): string {
  if (labelNames.length === 0) return '';
  const parts = labelNames.map((name) => `${name}="${labels[name] ?? ''}"`);
  return `{${parts.join(',')}}`;
}

export class Counter {
  constructor(private readonly metric: CounterMetric) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = keyOf(this.metric.labelNames, labels);
    this.metric.values.set(key, (this.metric.values.get(key) ?? 0) + by);
  }
}

export class Gauge {
  constructor(private readonly metric: GaugeMetric) {}

  set(labels: Labels, value: number): void {
    this.metric.values.set(keyOf(this.metric.labelNames, labels), value);
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = keyOf(this.metric.labelNames, labels);
    this.metric.values.set(key, (this.metric.values.get(key) ?? 0) + by);
  }

  dec(labels: Labels = {}, by = 1): void {
    this.inc(labels, -by);
  }
}

export class Histogram {
  constructor(private readonly metric: HistogramMetric) {}

  observe(labels: Labels, value: number): void {
    const key = keyOf(this.metric.labelNames, labels);
    let series = this.metric.values.get(key);
    if (series === undefined) {
      series = { counts: new Array<number>(this.metric.buckets.length + 1).fill(0), sum: 0, count: 0 };
      this.metric.values.set(key, series);
    }
    const index = this.metric.buckets.findIndex((bound) => value <= bound);
    series.counts[index === -1 ? this.metric.buckets.length : index] =
      (series.counts[index === -1 ? this.metric.buckets.length : index] ?? 0) + 1;
    series.sum += value;
    series.count += 1;
  }
}

/**
 * The generation-core metric set (PRD §21.3 subset). One instance per process; the composition
 * root passes it to the orchestrator, the SSE route and the /metrics endpoint.
 */
export interface GenerationMetrics {
  readonly registry: MetricsRegistry;
  readonly generationsStarted: Counter;
  readonly generationsFinished: Counter;
  readonly generationDuration: Histogram;
  readonly generationTtft: Histogram;
  readonly generationsActive: Gauge;
  readonly sseConnectionsActive: Gauge;
  readonly sseReconnects: Counter;
  readonly providerErrors: Counter;
}

export function createGenerationMetrics(): GenerationMetrics {
  const registry = new MetricsRegistry();
  return {
    registry,
    generationsStarted: registry.counter(
      'aichat_generations_started_total',
      'Generations that reached the generating state.',
      ['provider', 'model'],
    ),
    generationsFinished: registry.counter(
      'aichat_generations_finished_total',
      'Generations that reached a terminal state.',
      ['provider', 'model', 'outcome', 'error_category'],
    ),
    generationDuration: registry.histogram(
      'aichat_generation_duration_seconds',
      'Wall-clock duration of a generation.',
      ['provider', 'model'],
    ),
    generationTtft: registry.histogram(
      'aichat_generation_ttft_seconds',
      'Time to first emitted text for a generation.',
      ['provider', 'model'],
    ),
    generationsActive: registry.gauge(
      'aichat_generations_active',
      'Generations currently held by this process.',
      ['provider'],
    ),
    sseConnectionsActive: registry.gauge(
      'aichat_sse_connections_active',
      'Open SSE stream connections.',
    ),
    sseReconnects: registry.counter(
      'aichat_sse_reconnects_total',
      'SSE connections that resumed from Last-Event-ID.',
    ),
    providerErrors: registry.counter(
      'aichat_provider_errors_total',
      'Provider errors by normalized category.',
      ['provider', 'category'],
    ),
  };
}
