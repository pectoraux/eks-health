/**
 * Eks-Health Kernel — Observability Platform
 *
 * Production observability for the kernel: metrics, logs, distributed traces,
 * health checks, and alerting in one cohesive facade. Designed to be the single
 * integration point for OpenTelemetry collectors, dashboards, and on-call tools.
 *
 * Capabilities:
 *  - Metrics: counter / gauge / histogram / summary, tagged, in-memory store.
 *  - Logs: structured records with level + trace correlation, ring buffer.
 *  - Tracer: span/trace tree with explicit traceId/spanId/parentSpanId
 *    propagation (no AsyncLocalStorage — caller passes handles explicitly).
 *  - Health checks: registered probes with cached last-known results.
 *  - Alerting: threshold rules auto-evaluated against every metric sample.
 *  - Snapshot: unified dashboard payload covering all five pillars.
 *
 * The default adapter is in-memory. Production wires this to OTLP/Prometheus/
 * Loki/Tempo/Jaeger without touching application code.
 */

import type {
  CorrelationId,
  HealthStatus,
  LifecycleState,
  TraceId,
} from "../core";
import { generateId, getClock } from "../core";
import { getEventBus } from "../events";
import { getScheduler } from "../scheduler";
import { getConfiguration } from "../config";
import { getStorage } from "../storage";

// ---------------------------------------------------------------------------
// Metric types
// ---------------------------------------------------------------------------

export type MetricType = "counter" | "gauge" | "histogram" | "summary";
export type MetricTags = Record<string, string>;

export interface MetricSample {
  readonly value: number;
  readonly timestamp: string;
  readonly tags: MetricTags;
}

export interface Metric {
  readonly name: string;
  readonly type: MetricType;
  readonly value: number;
  readonly tags: MetricTags;
  readonly unit?: string;
  readonly description?: string;
  readonly updatedAt: string;
  /** For histograms/summaries: the recorded samples (capped). */
  readonly samples?: readonly MetricSample[];
  /** For histograms: pre-computed statistics. */
  readonly stats?: HistogramStats;
}

export interface HistogramStats {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface MetricFilter {
  readonly name?: string | RegExp;
  readonly type?: MetricType;
  readonly tags?: MetricTags;
}

// ---------------------------------------------------------------------------
// Log types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogContext extends Record<string, unknown> {
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly service?: string;
}

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly service?: string;
}

export interface LogFilter {
  readonly level?: LogLevel | LogLevel[];
  readonly since?: string; // ISO
  readonly until?: string; // ISO
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly messageMatches?: string | RegExp;
}

// ---------------------------------------------------------------------------
// Trace types
// ---------------------------------------------------------------------------

export type SpanStatus = "active" | "ended" | "error";

export interface SpanEvent {
  readonly name: string;
  readonly timestamp: string;
  readonly attributes?: Record<string, unknown>;
}

export interface Span {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: readonly SpanEvent[];
  readonly error?: { readonly message: string; readonly stack?: string };
}

export interface Trace {
  readonly traceId: string;
  readonly spans: readonly Span[];
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly status: SpanStatus;
}

// ---------------------------------------------------------------------------
// Health check types
// ---------------------------------------------------------------------------

export type HealthCheckFn = () => Promise<HealthStatus>;

export interface HealthCheck {
  readonly name: string;
  readonly description?: string;
  readonly check: HealthCheckFn;
  readonly lastResult?: HealthStatus;
}

// ---------------------------------------------------------------------------
// Alert types
// ---------------------------------------------------------------------------

export type AlertSeverity = "info" | "warning" | "error" | "critical";
export type AlertComparison = "gt" | "gte" | "lt" | "lte" | "eq";

export interface AlertRule {
  readonly id: string;
  readonly name: string;
  readonly metric: string;
  readonly threshold: number;
  readonly comparison: AlertComparison;
  readonly severity: AlertSeverity;
  readonly cooldownMs?: number;
  readonly description?: string;
  readonly tags?: MetricTags;
}

export interface Alert {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly severity: AlertSeverity;
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
  readonly comparison: AlertComparison;
  readonly triggeredAt: string;
  readonly acknowledgedAt?: string;
  readonly acknowledgedBy?: string;
  readonly status: "active" | "acknowledged" | "resolved";
  readonly message: string;
  readonly tags?: MetricTags;
}

// ---------------------------------------------------------------------------
// MetricsRegistry
// ---------------------------------------------------------------------------

interface InternalMetric {
  name: string;
  type: MetricType;
  value: number;
  tags: MetricTags;
  unit?: string;
  description?: string;
  updatedAt: string;
  samples: MetricSample[];
  sum: number;
  count: number;
  min: number;
  max: number;
}

interface InternalHistogram extends InternalMetric {
  type: "histogram" | "summary";
}

function tagsKey(tags: MetricTags): string {
  const keys = Object.keys(tags).sort();
  return keys.map((k) => `${k}=${tags[k]}`).join(",");
}

function computeQuantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function computeHistogramStats(m: InternalMetric): HistogramStats {
  const values = m.samples.map((s) => s.value).sort((a, b) => a - b);
  const count = values.length;
  const sum = m.sum;
  const min = count > 0 ? values[0] : 0;
  const max = count > 0 ? values[count - 1] : 0;
  const mean = count > 0 ? sum / count : 0;
  return {
    count,
    sum,
    min,
    max,
    mean,
    p50: computeQuantile(values, 0.5),
    p95: computeQuantile(values, 0.95),
    p99: computeQuantile(values, 0.99),
  };
}

function toMetric(m: InternalMetric): Metric {
  if (m.type === "histogram" || m.type === "summary") {
    return {
      name: m.name,
      type: m.type,
      value: m.value,
      tags: { ...m.tags },
      unit: m.unit,
      description: m.description,
      updatedAt: m.updatedAt,
      samples: [...m.samples],
      stats: computeHistogramStats(m),
    };
  }
  return {
    name: m.name,
    type: m.type,
    value: m.value,
    tags: { ...m.tags },
    unit: m.unit,
    description: m.description,
    updatedAt: m.updatedAt,
  };
}

export type MetricListener = (metric: Metric) => void;

export class MetricsRegistry {
  private readonly metrics = new Map<string, InternalMetric>();
  private readonly listeners = new Set<MetricListener>();
  private readonly sampleCap = 1000; // per-histogram sample retention

  /** Subscribe to metric updates. Returns an unsubscribe fn. */
  onMetric(listener: MetricListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(m: InternalMetric): void {
    const snap = toMetric(m);
    for (const l of this.listeners) l(snap);
  }

  /** Increment a counter by `value` (default 1). */
  counter(name: string, value = 1, tags: MetricTags = {}): void {
    const key = `${name}|${tagsKey(tags)}`;
    const existing = this.metrics.get(key);
    if (existing && existing.type === "counter") {
      existing.value += value;
      existing.updatedAt = getClock().iso();
      this.notify(existing);
    } else if (!existing) {
      const m: InternalMetric = {
        name,
        type: "counter",
        value,
        tags,
        updatedAt: getClock().iso(),
        samples: [],
        sum: value,
        count: 1,
        min: value,
        max: value,
      };
      this.metrics.set(key, m);
      this.notify(m);
    } else {
      // Type mismatch — overwrite with the new metric type.
      const m: InternalMetric = {
        name,
        type: "counter",
        value,
        tags,
        updatedAt: getClock().iso(),
        samples: [],
        sum: value,
        count: 1,
        min: value,
        max: value,
      };
      this.metrics.set(key, m);
      this.notify(m);
    }
  }

  /** Convenience: increment a counter by 1. */
  increment(name: string, tags: MetricTags = {}): void {
    this.counter(name, 1, tags);
  }

  /** Set a gauge to an absolute value. */
  gauge(name: string, value: number, tags: MetricTags = {}): void {
    const key = `${name}|${tagsKey(tags)}`;
    const m: InternalMetric = {
      name,
      type: "gauge",
      value,
      tags,
      updatedAt: getClock().iso(),
      samples: [],
      sum: value,
      count: 1,
      min: value,
      max: value,
    };
    this.metrics.set(key, m);
    this.notify(m);
  }

  /** Record a sample into a histogram. */
  histogram(name: string, value: number, tags: MetricTags = {}): void {
    this.recordSample(name, "histogram", value, tags);
  }

  /** Alias for histogram (OTel-style naming). */
  observe(name: string, value: number, tags: MetricTags = {}): void {
    this.recordSample(name, "summary", value, tags);
  }

  private recordSample(
    name: string,
    type: "histogram" | "summary",
    value: number,
    tags: MetricTags,
  ): void {
    const key = `${name}|${tagsKey(tags)}`;
    let m = this.metrics.get(key) as InternalHistogram | undefined;
    if (!m || (m.type !== "histogram" && m.type !== "summary")) {
      m = {
        name,
        type,
        value,
        tags,
        updatedAt: getClock().iso(),
        samples: [],
        sum: 0,
        count: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
      } as InternalHistogram;
      this.metrics.set(key, m);
    }
    const sample: MetricSample = {
      value,
      timestamp: getClock().iso(),
      tags: { ...tags },
    };
    m.samples.push(sample);
    if (m.samples.length > this.sampleCap) {
      m.samples = m.samples.slice(-this.sampleCap);
    }
    m.sum += value;
    m.count += 1;
    if (value < m.min) m.min = value;
    if (value > m.max) m.max = value;
    m.value = value; // latest observed value
    m.updatedAt = sample.timestamp;
    this.notify(m);
  }

  getMetrics(filter?: MetricFilter): Metric[] {
    const all = [...this.metrics.values()].map(toMetric);
    if (!filter) return all;
    return all.filter((m) => {
      if (filter.name) {
        if (typeof filter.name === "string") {
          if (m.name !== filter.name) return false;
        } else if (!filter.name.test(m.name)) {
          return false;
        }
      }
      if (filter.type && m.type !== filter.type) return false;
      if (filter.tags) {
        for (const [k, v] of Object.entries(filter.tags)) {
          if (m.tags[k] !== v) return false;
        }
      }
      return true;
    });
  }

  /** For maintenance / tests. */
  reset(): void {
    this.metrics.clear();
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  readonly silent?: boolean;
  readonly capacity?: number;
  readonly service?: string;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export class Logger {
  private readonly buffer: LogRecord[] = [];
  private readonly capacity: number;
  private readonly silent: boolean;
  private readonly defaultService?: string;
  private head = 0;

  constructor(opts: LoggerOptions = {}) {
    this.capacity = opts.capacity ?? 1000;
    this.silent = opts.silent ?? false;
    this.defaultService = opts.service;
  }

  private push(record: LogRecord): void {
    if (this.buffer.length < this.capacity) {
      this.buffer.push(record);
    } else {
      this.buffer[this.head] = record;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  private writeToConsole(record: LogRecord): void {
    const fn =
      record.level === "fatal" || record.level === "error"
        ? console.error
        : record.level === "warn"
          ? console.warn
          : record.level === "info"
            ? console.info
            : console.debug;
    const trace = record.traceId ? ` [${record.traceId}]` : "";
    const svc = record.service ? ` (${record.service})` : "";
    fn(`${record.timestamp}${svc}${trace} ${record.level.toUpperCase()} ${record.message}`);
    if (record.context && Object.keys(record.context).length > 0) {
      fn(record.context);
    }
  }

  log(level: LogLevel, message: string, context?: LogContext): void {
    const { traceId, correlationId, service, ...rest } = context ?? {};
    const record: LogRecord = {
      timestamp: getClock().iso(),
      level,
      message,
      context: Object.keys(rest).length > 0 ? rest : undefined,
      traceId: traceId as string | undefined,
      correlationId: correlationId as string | undefined,
      service: (service as string | undefined) ?? this.defaultService,
    };
    this.push(record);
    if (!this.silent) this.writeToConsole(record);
  }

  debug(message: string, context?: LogContext): void {
    this.log("debug", message, context);
  }
  info(message: string, context?: LogContext): void {
    this.log("info", message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.log("warn", message, context);
  }
  error(message: string, context?: LogContext): void {
    this.log("error", message, context);
  }
  fatal(message: string, context?: LogContext): void {
    this.log("fatal", message, context);
  }

  getLogs(filter?: LogFilter): LogRecord[] {
    let ordered: LogRecord[];
    if (this.buffer.length < this.capacity) {
      ordered = [...this.buffer];
    } else {
      // Ring buffer: head points to the oldest slot when full.
      ordered = [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
    }
    if (!filter) return ordered;
    return ordered.filter((r) => {
      if (filter.level) {
        if (Array.isArray(filter.level)) {
          if (!filter.level.includes(r.level)) return false;
        } else if (r.level !== filter.level) {
          return false;
        }
      }
      if (filter.since && r.timestamp < filter.since) return false;
      if (filter.until && r.timestamp > filter.until) return false;
      if (filter.traceId && r.traceId !== filter.traceId) return false;
      if (filter.correlationId && r.correlationId !== filter.correlationId) {
        return false;
      }
      if (filter.messageMatches) {
        const re =
          typeof filter.messageMatches === "string"
            ? new RegExp(filter.messageMatches, "i")
            : filter.messageMatches;
        if (!re.test(r.message)) return false;
      }
      return true;
    });
  }

  /** For maintenance / tests. */
  reset(): void {
    this.buffer.length = 0;
    this.head = 0;
  }
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

interface InternalSpan {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  error?: { message: string; stack?: string };
}

interface InternalTrace {
  traceId: string;
  spans: InternalSpan[];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: SpanStatus;
}

export class SpanHandle implements Span {
  private readonly span: InternalSpan;
  private readonly trace: InternalTrace;
  private readonly tracer: Tracer;

  constructor(span: InternalSpan, trace: InternalTrace, tracer: Tracer) {
    this.span = span;
    this.trace = trace;
    this.tracer = tracer;
  }

  get spanId(): string {
    return this.span.spanId;
  }
  get traceId(): string {
    return this.span.traceId;
  }
  get parentSpanId(): string | undefined {
    return this.span.parentSpanId;
  }
  get name(): string {
    return this.span.name;
  }
  get startedAt(): string {
    return this.span.startedAt;
  }
  get endedAt(): string | undefined {
    return this.span.endedAt;
  }
  get durationMs(): number | undefined {
    return this.span.durationMs;
  }
  get status(): SpanStatus {
    return this.span.status;
  }
  get attributes(): Readonly<Record<string, unknown>> {
    return this.span.attributes;
  }
  get events(): readonly SpanEvent[] {
    return this.span.events;
  }
  get error(): { readonly message: string; readonly stack?: string } | undefined {
    return this.span.error;
  }

  /** Set an attribute on the span (OTel-compatible). Chainable. */
  setAttribute(key: string, value: unknown): this {
    this.span.attributes[key] = value;
    return this;
  }

  /** Set multiple attributes at once. Chainable. */
  setAttributes(attrs: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(attrs)) {
      this.span.attributes[k] = v;
    }
    return this;
  }

  /** Record a structured event on the span. Chainable. */
  addEvent(name: string, attributes?: Record<string, unknown>): this {
    this.span.events.push({
      name,
      timestamp: getClock().iso(),
      attributes,
    });
    return this;
  }

  /** Record an error on the span; status becomes "error". Chainable. */
  recordError(error: Error): this {
    this.span.status = "error";
    this.span.error = {
      message: error.message,
      stack: error.stack,
    };
    this.trace.status = "error";
    return this;
  }

  /** End the span. Idempotent. */
  end(): void {
    if (this.span.endedAt) return;
    this.span.endedAt = getClock().iso();
    const startMs = Date.parse(this.span.startedAt);
    const endMs = Date.parse(this.span.endedAt);
    this.span.durationMs = endMs - startMs;
    if (this.span.status !== "error") {
      this.span.status = "ended";
    }
    this.tracer.onSpanEnded(this.span, this.trace);
  }

  /** Snapshot as a plain object (for JSON serialization). */
  toJSON(): Span {
    return {
      spanId: this.span.spanId,
      traceId: this.span.traceId,
      parentSpanId: this.span.parentSpanId,
      name: this.span.name,
      startedAt: this.span.startedAt,
      endedAt: this.span.endedAt,
      durationMs: this.span.durationMs,
      status: this.span.status,
      attributes: { ...this.span.attributes },
      events: [...this.span.events],
      error: this.span.error,
    };
  }
}

export class Tracer {
  private readonly traces = new Map<string, InternalTrace>();
  private currentTraceId?: string;

  /** Start a new span. If parentSpanId is given, the span joins that trace. */
  startSpan(name: string, parentSpanId?: string): SpanHandle {
    const spanId = generateId("spn_");
    let traceId: string;
    let parentTrace: InternalTrace | undefined;
    if (parentSpanId) {
      parentTrace = this.findTraceBySpan(parentSpanId);
      traceId = parentTrace?.traceId ?? generateId("trc_");
    } else {
      traceId = generateId("trc_");
    }
    const span: InternalSpan = {
      spanId,
      traceId,
      parentSpanId,
      name,
      startedAt: getClock().iso(),
      status: "active",
      attributes: {},
      events: [],
    };
    let trace = this.traces.get(traceId);
    if (!trace) {
      trace = {
        traceId,
        spans: [],
        startedAt: span.startedAt,
        status: "active",
      };
      this.traces.set(traceId, trace);
    }
    trace.spans.push(span);
    this.currentTraceId = traceId;
    return new SpanHandle(span, trace, this);
  }

  private findTraceBySpan(spanId: string): InternalTrace | undefined {
    for (const t of this.traces.values()) {
      if (t.spans.some((s) => s.spanId === spanId)) return t;
    }
    return undefined;
  }

  /** Called by SpanHandle.end() to finalize the trace if all spans ended. */
  /* @internal */
  onSpanEnded(span: InternalSpan, trace: InternalTrace): void {
    void span; // span already mutated in place
    const allEnded = trace.spans.every(
      (s) => s.endedAt !== undefined || s.status === "error",
    );
    if (allEnded && trace.spans.length > 0) {
      const ends = trace.spans
        .map((s) => (s.endedAt ? Date.parse(s.endedAt) : 0))
        .filter((t) => t > 0);
      const starts = trace.spans.map((s) => Date.parse(s.startedAt));
      const startMs = Math.min(...starts);
      const endMs = ends.length > 0 ? Math.max(...ends) : startMs;
      trace.endedAt = new Date(endMs).toISOString();
      trace.durationMs = endMs - startMs;
      if (trace.status !== "error") trace.status = "ended";
    }
  }

  getTrace(traceId: string): Trace | undefined {
    const t = this.traces.get(traceId);
    if (!t) return undefined;
    return {
      traceId: t.traceId,
      spans: [...t.spans] as Span[],
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      durationMs: t.durationMs,
      status: t.status,
    };
  }

  /** Returns the most recently started trace, if any. */
  getCurrentTrace(): Trace | undefined {
    if (!this.currentTraceId) return undefined;
    return this.getTrace(this.currentTraceId);
  }

  listTraces(limit = 100): Trace[] {
    return [...this.traces.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((t) => ({
        traceId: t.traceId,
        spans: [...t.spans] as Span[],
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        durationMs: t.durationMs,
        status: t.status,
      }));
  }

  /** For maintenance / tests. */
  reset(): void {
    this.traces.clear();
    this.currentTraceId = undefined;
  }
}

// ---------------------------------------------------------------------------
// HealthRegistry
// ---------------------------------------------------------------------------

export class HealthRegistry {
  private readonly checks = new Map<string, HealthCheck>();
  private lastResults: Record<string, HealthStatus> = {};

  register(name: string, check: HealthCheckFn, description?: string): void {
    this.checks.set(name, { name, check, description });
  }

  unregister(name: string): void {
    this.checks.delete(name);
    delete this.lastResults[name];
  }

  list(): string[] {
    return [...this.checks.keys()];
  }

  async run(name: string): Promise<HealthStatus> {
    const c = this.checks.get(name);
    if (!c) {
      return {
        state: "terminated" as LifecycleState,
        healthy: false,
        checkedAt: getClock().iso(),
        details: { error: `Unknown health check: ${name}` },
      };
    }
    const start = Date.now();
    try {
      const result = await c.check();
      const withLatency: HealthStatus = {
        ...result,
        checkedAt: getClock().iso(),
        latencyMs: Date.now() - start,
      };
      this.lastResults[name] = withLatency;
      (this.checks.get(name) as { lastResult?: HealthStatus }).lastResult =
        withLatency;
      return withLatency;
    } catch (e) {
      const errorResult: HealthStatus = {
        state: "degraded" as LifecycleState,
        healthy: false,
        checkedAt: getClock().iso(),
        latencyMs: Date.now() - start,
        details: {
          error: e instanceof Error ? e.message : String(e),
        },
      };
      this.lastResults[name] = errorResult;
      (this.checks.get(name) as { lastResult?: HealthStatus }).lastResult =
        errorResult;
      return errorResult;
    }
  }

  async runAll(): Promise<Record<string, HealthStatus>> {
    const names = [...this.checks.keys()];
    const entries = await Promise.all(
      names.map(async (n) => [n, await this.run(n)] as const),
    );
    this.lastResults = Object.fromEntries(entries);
    return { ...this.lastResults };
  }

  /** Synchronous access to the last cached results (no I/O). */
  getLastResults(): Record<string, HealthStatus> {
    return { ...this.lastResults };
  }
}

// ---------------------------------------------------------------------------
// AlertManager
// ---------------------------------------------------------------------------

interface InternalAlert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  metric: string;
  value: number;
  threshold: number;
  comparison: AlertComparison;
  triggeredAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  status: "active" | "acknowledged" | "resolved";
  message: string;
  tags?: MetricTags;
}

export class AlertManager {
  private readonly rules = new Map<string, AlertRule>();
  private readonly alerts: InternalAlert[] = [];
  private readonly lastTriggerPerRule = new Map<string, number>();

  registerRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
  }

  listRules(): AlertRule[] {
    return [...this.rules.values()];
  }

  /**
   * Evaluate a metric against all matching rules. Returns any new alerts
   * created by this evaluation. Active alerts respect per-rule cooldown.
   */
  evaluate(metric: Metric): Alert[] {
    const newAlerts: InternalAlert[] = [];
    const now = Date.now();
    for (const rule of this.rules.values()) {
      if (rule.metric !== metric.name) continue;
      if (rule.tags) {
        let tagsMatch = true;
        for (const [k, v] of Object.entries(rule.tags)) {
          if (metric.tags[k] !== v) {
            tagsMatch = false;
            break;
          }
        }
        if (!tagsMatch) continue;
      }
      if (!this.compare(metric.value, rule.comparison, rule.threshold)) continue;
      // Cooldown: don't re-fire an active alert for the same rule within window.
      const last = this.lastTriggerPerRule.get(rule.id);
      if (rule.cooldownMs && last && now - last < rule.cooldownMs) continue;
      // Don't create a duplicate if an alert for this rule is already active.
      const hasActive = this.alerts.some(
        (a) => a.ruleId === rule.id && a.status === "active",
      );
      if (hasActive) continue;
      const alert: InternalAlert = {
        id: `alr_${generateId()}`,
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        metric: metric.name,
        value: metric.value,
        threshold: rule.threshold,
        comparison: rule.comparison,
        triggeredAt: getClock().iso(),
        status: "active",
        message: `${rule.name}: ${metric.name} ${rule.comparison} ${rule.threshold} (current: ${metric.value})`,
        tags: rule.tags ? { ...rule.tags } : undefined,
      };
      this.alerts.push(alert);
      this.lastTriggerPerRule.set(rule.id, now);
      newAlerts.push(alert);
    }
    return newAlerts as Alert[];
  }

  getActiveAlerts(): Alert[] {
    return this.alerts.filter((a) => a.status === "active") as Alert[];
  }

  getAllAlerts(limit = 200): Alert[] {
    return [...this.alerts].slice(-limit) as Alert[];
  }

  acknowledge(alertId: string, by?: string): boolean {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (!alert) return false;
    if (alert.status !== "active") return false;
    alert.status = "acknowledged";
    alert.acknowledgedAt = getClock().iso();
    alert.acknowledgedBy = by;
    return true;
  }

  resolve(alertId: string): boolean {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (!alert) return false;
    if (alert.status === "resolved") return false;
    alert.status = "resolved";
    return true;
  }

  private compare(
    value: number,
    op: AlertComparison,
    threshold: number,
  ): boolean {
    switch (op) {
      case "gt":
        return value > threshold;
      case "gte":
        return value >= threshold;
      case "lt":
        return value < threshold;
      case "lte":
        return value <= threshold;
      case "eq":
        return value === threshold;
    }
  }

  /** For maintenance / tests. */
  reset(): void {
    this.rules.clear();
    this.alerts.length = 0;
    this.lastTriggerPerRule.clear();
  }
}

// ---------------------------------------------------------------------------
// Observability facade
// ---------------------------------------------------------------------------

export interface ObservabilitySnapshot {
  readonly timestamp: string;
  readonly metrics: Metric[];
  readonly metricCount: number;
  readonly logCount: number;
  readonly recentLogs: LogRecord[];
  readonly traceCount: number;
  readonly recentTraces: Trace[];
  readonly healthChecks: string[];
  readonly health: Record<string, HealthStatus>;
  readonly activeAlerts: Alert[];
  readonly alertCount: number;
  readonly ruleCount: number;
  readonly stats: {
    readonly metricCount: number;
    readonly logCount: number;
    readonly traceCount: number;
    readonly activeAlertCount: number;
    readonly healthCheckCount: number;
    readonly ruleCount: number;
  };
}

export class Observability {
  readonly metrics: MetricsRegistry;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly health: HealthRegistry;
  readonly alerts: AlertManager;

  constructor() {
    this.metrics = new MetricsRegistry();
    this.logger = new Logger({ service: "kernel" });
    this.tracer = new Tracer();
    this.health = new HealthRegistry();
    this.alerts = new AlertManager();
    this.registerDefaultHealthChecks();
    // Wire metrics -> alerts so threshold breaches fire automatically.
    this.metrics.onMetric((m) => {
      const fired = this.alerts.evaluate(m);
      for (const a of fired) {
        this.logger.warn(`Alert fired: ${a.message}`, {
          alertId: a.id,
          ruleId: a.ruleId,
          severity: a.severity,
        });
      }
    });
  }

  private registerDefaultHealthChecks(): void {
    this.health.register(
      "kernel.events",
      async () => {
        const stats = getEventBus().getStats();
        return {
          state: "active" as LifecycleState,
          healthy: true,
          checkedAt: getClock().iso(),
          details: { stats },
        };
      },
      "Kernel event bus health",
    );

    this.health.register(
      "kernel.scheduler",
      async () => {
        const stats = getScheduler().getStats();
        return {
          state: "active" as LifecycleState,
          healthy: true,
          checkedAt: getClock().iso(),
          details: { stats },
        };
      },
      "Distributed scheduler health",
    );

    this.health.register(
      "kernel.storage",
      async () => {
        const stats = getStorage().stats();
        return {
          state: "active" as LifecycleState,
          healthy: true,
          checkedAt: getClock().iso(),
          details: { stats },
        };
      },
      "Object storage health",
    );

    this.health.register(
      "kernel.config",
      async () => {
        const cfg = getConfiguration();
        return {
          state: "active" as LifecycleState,
          healthy: true,
          checkedAt: getClock().iso(),
          details: {
            schemas: cfg.listSchemas().length,
            overrides: cfg.listOverrides().length,
          },
        };
      },
      "Configuration platform health",
    );
  }

  /** Convenience: start a span via the tracer. */
  startSpan(name: string, parentSpanId?: string): SpanHandle {
    return this.tracer.startSpan(name, parentSpanId);
  }

  /** Convenience: log at info level. */
  log(message: string, context?: LogContext): void {
    this.logger.info(message, context);
  }

  /**
   * Unified dashboard snapshot. Synchronous — uses cached health results.
   * Call `await observability.health.runAll()` first to refresh health.
   */
  snapshot(): ObservabilitySnapshot {
    const metricsList = this.metrics.getMetrics();
    const logs = this.logger.getLogs();
    const traces = this.tracer.listTraces(50);
    const activeAlerts = this.alerts.getActiveAlerts();
    const rules = this.alerts.listRules();
    const health = this.health.getLastResults();
    return {
      timestamp: getClock().iso(),
      metrics: metricsList,
      metricCount: metricsList.length,
      logCount: logs.length,
      recentLogs: logs.slice(-200),
      traceCount: this.tracer.listTraces().length,
      recentTraces: traces,
      healthChecks: this.health.list(),
      health,
      activeAlerts,
      alertCount: activeAlerts.length,
      ruleCount: rules.length,
      stats: {
        metricCount: metricsList.length,
        logCount: logs.length,
        traceCount: this.tracer.listTraces().length,
        activeAlertCount: activeAlerts.length,
        healthCheckCount: this.health.list().length,
        ruleCount: rules.length,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _obs: Observability | null = null;

export function getObservability(): Observability {
  if (!_obs) _obs = new Observability();
  return _obs;
}

export function setObservability(obs: Observability): void {
  _obs = obs;
}

export function resetObservability(): void {
  _obs = null;
}

// ---------------------------------------------------------------------------
// Re-exports of cross-module types used in this module's public API
// ---------------------------------------------------------------------------

export type { CorrelationId, HealthStatus, LifecycleState, TraceId } from "../core";
