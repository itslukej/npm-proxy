const COUNTERS = [
  ['metadata_requests_total', 'Package metadata requests received'],
  ['metadata_cache_hits_total', 'Upstream packument cache hits'],
  ['metadata_cache_misses_total', 'Upstream packument cache misses'],
  ['versions_blocked_total', 'Versions removed from metadata by the age policy'],
  ['tarballs_allowed_total', 'Tarball downloads allowed'],
  ['tarballs_blocked_total', 'Tarball downloads blocked by the age policy'],
  ['upstream_errors_total', 'Upstream registry failures'],
] as const;

export type CounterName = (typeof COUNTERS)[number][0];

export class Metrics {
  private counts = new Map<CounterName, number>(COUNTERS.map(([name]) => [name, 0]));

  inc(name: CounterName, by = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by);
  }

  get(name: CounterName): number {
    return this.counts.get(name) ?? 0;
  }

  /** Render all counters in the Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const [name, help] of COUNTERS) {
      const full = `npm_proxy_${name}`;
      lines.push(`# HELP ${full} ${help}`);
      lines.push(`# TYPE ${full} counter`);
      lines.push(`${full} ${this.counts.get(name) ?? 0}`);
    }
    return lines.join('\n') + '\n';
  }
}
