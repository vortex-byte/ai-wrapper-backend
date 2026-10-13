import { describe, expect, it } from 'vitest';
import { createGenerationMetrics, MetricsRegistry } from '@/observability/metrics.ts';

describe('MetricsRegistry', () => {
  it('renders counters with and without labels in the exposition format', () => {
    const registry = new MetricsRegistry();
    const requests = registry.counter('aichat_requests_total', 'Requests.', ['code']);
    requests.inc({ code: '200' });
    requests.inc({ code: '200' });
    requests.inc({ code: '500' });

    const text = registry.render();
    expect(text).toContain('# HELP aichat_requests_total Requests.');
    expect(text).toContain('# TYPE aichat_requests_total counter');
    expect(text).toContain('aichat_requests_total{code="200"} 2');
    expect(text).toContain('aichat_requests_total{code="500"} 1');
  });

  it('renders gauges that can go up and down', () => {
    const registry = new MetricsRegistry();
    const active = registry.gauge('aichat_active', 'Active.', ['provider']);
    active.inc({ provider: 'openai' });
    active.inc({ provider: 'openai' });
    active.dec({ provider: 'openai' });
    expect(registry.render()).toContain('aichat_active{provider="openai"} 1');
  });

  it('accumulates histogram buckets cumulatively with _sum and _count', () => {
    const registry = new MetricsRegistry();
    const duration = registry.histogram('aichat_duration_seconds', 'Duration.', ['m'], [0.5, 1, 2]);
    duration.observe({ m: 'a' }, 0.25);
    duration.observe({ m: 'a' }, 0.75);
    duration.observe({ m: 'a' }, 5);

    const text = registry.render();
    expect(text).toContain('aichat_duration_seconds_bucket{m="a",le="0.5"} 1');
    expect(text).toContain('aichat_duration_seconds_bucket{m="a",le="1"} 2');
    expect(text).toContain('aichat_duration_seconds_bucket{m="a",le="2"} 2');
    expect(text).toContain('aichat_duration_seconds_bucket{m="a",le="+Inf"} 3');
    expect(text).toContain('aichat_duration_seconds_sum{m="a"} 6');
    expect(text).toContain('aichat_duration_seconds_count{m="a"} 3');
  });

  it('returns an empty body when nothing has been recorded', () => {
    expect(new MetricsRegistry().render()).toBe('');
  });

  it('reset() clears series but keeps metric definitions', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('aichat_x_total', 'X.');
    counter.inc();
    expect(registry.render()).toContain('aichat_x_total 1');
    registry.reset();
    expect(registry.render()).toContain('# TYPE aichat_x_total counter');
    expect(registry.render()).not.toContain('aichat_x_total 1');
  });
});

describe('createGenerationMetrics', () => {
  it('registers the phase-2 generation metric set', () => {
    const metrics = createGenerationMetrics();
    metrics.generationsStarted.inc({ provider: 'openai', model: 'gpt-4o' });
    metrics.generationsFinished.inc({
      provider: 'openai',
      model: 'gpt-4o',
      outcome: 'completed',
      error_category: '',
    });
    metrics.generationsActive.set({ provider: 'openai' }, 3);
    metrics.sseConnectionsActive.set({}, 1);

    const text = metrics.registry.render();
    expect(text).toContain('aichat_generations_started_total{provider="openai",model="gpt-4o"} 1');
    expect(text).toContain('aichat_generations_active{provider="openai"} 3');
    expect(text).toContain('aichat_sse_connections_active 1');
    expect(text).toContain('# TYPE aichat_generation_duration_seconds histogram');
  });

  it('renders through healthRoutes /metrics endpoint', async () => {
    const { healthRoutes } = await import('@/health/routes.ts');
    const { loadConfig } = await import('@/config/env.ts');
    const config = loadConfig({
      DATABASE_URL: 'postgresql://aichat:changeme@127.0.0.1:5432/aichat_test',
      SESSION_SECRET: '01234567890123456789012345678901',
      NODE_ENV: 'test',
    });
    const metrics = createGenerationMetrics();
    metrics.generationsStarted.inc({ provider: 'openai', model: 'gpt-4o' });

    const routes = healthRoutes(config, metrics.registry);
    const res = await routes.request('http://localhost/metrics');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('aichat_up 1');
    expect(text).toContain('aichat_generations_started_total{provider="openai",model="gpt-4o"} 1');
  });
});
