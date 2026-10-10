/**
 * Small charts inside chat replies. The assistant writes a ```chart block with JSON:
 *   { "type": "bar" | "line", "title": "…", "unit": "$", "labels": [...], "series": [{ "name": "…", "values": [...] }] }
 * ("values": [...] on its own is shorthand for one series). Rendered as SVG with no dependencies.
 */

export interface ChartSpec {
  type?: 'bar' | 'line';
  title?: string;
  unit?: string;
  labels: string[];
  series: { name?: string; values: number[] }[];
}

/** Validates loose model output into a chart spec, or null if it isn't one. */
export function parseChart(json: string): ChartSpec | null {
  try {
    const raw = JSON.parse(json);
    const series = (raw.series ?? (raw.values ? [{ values: raw.values }] : []))
      .slice(0, 4)
      .map((s: any) => ({ name: s.name ? String(s.name) : undefined, values: (s.values ?? []).map(Number) }));
    const labels: string[] = (raw.labels ?? []).map(String);
    if (!labels.length || !series.length || series.some((s: any) => s.values.length !== labels.length || s.values.some((v: number) => !Number.isFinite(v))))
      return null;
    return {
      type: raw.type === 'line' ? 'line' : 'bar',
      title: raw.title ? String(raw.title) : undefined,
      unit: raw.unit ? String(raw.unit) : undefined,
      labels,
      series,
    };
  } catch {
    return null;
  }
}

const W = 560;
const H = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * step).find((m) => m >= v)!;
}

export function Chart({ spec }: { spec: ChartSpec }) {
  const { labels, series, unit = '' } = spec;
  const max = niceMax(Math.max(...series.flatMap((s) => s.values), 0));
  const min = Math.min(0, ...series.flatMap((s) => s.values));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;
  const band = plotW / labels.length;
  // Currency goes before the number and short units ("%", "kg") after it; a long unit ("million people")
  // would crowd the axis, so it goes in the caption and the hover values instead.
  const money = unit.length === 1 && '$€£₹'.includes(unit);
  const long = !money && unit.length > 3;
  const fmt = (v: number, withLong = false) =>
    `${money ? unit : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${!unit || money || (long && !withLong) ? '' : unit === '%' ? '%' : ` ${unit}`}`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + (max - min) * t);
  const every = Math.ceil(labels.length / 10); // keep x labels readable
  const summary = `${spec.title ?? 'Chart'}: ${labels.map((l, i) => `${l} ${series.map((s) => fmt(s.values[i], true)).join(' / ')}`).join(', ')}`;

  return (
    <figure className="chart">
      {(spec.title || long) && (
        <figcaption>
          {spec.title}
          {long && <span className="chart-unit">{spec.title ? ` · ${unit}` : unit}</span>}
        </figcaption>
      )}
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s, i) => (
            <span key={i}>
              <i className={`s${i + 1}`} />
              {s.name ?? `Series ${i + 1}`}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
              {fmt(Math.round(t * 100) / 100)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % every ? null : (
            <text key={i} className="tick" x={PAD.left + band * (i + 0.5)} y={H - 8} textAnchor="middle">
              {l.length > 10 ? `${l.slice(0, 9)}…` : l}
            </text>
          ),
        )}
        {spec.type === 'line'
          ? series.map((s, si) => {
              const pts = s.values.map((v, i) => [PAD.left + band * (i + 0.5), y(v)] as const);
              const last = pts[pts.length - 1];
              return (
                <g key={si} className={`s${si + 1}`}>
                  <polyline className="line" points={pts.map((p) => p.join(',')).join(' ')} />
                  {pts.map(([px, py], i) => (
                    <circle key={i} className="dot" cx={px} cy={py} r={i === pts.length - 1 ? 4.5 : 3}>
                      <title>{`${labels[i]}${s.name ? ` · ${s.name}` : ''}: ${fmt(s.values[i], true)}`}</title>
                    </circle>
                  ))}
                  {series.length === 1 && (
                    <text className="value" x={last[0]} y={last[1] - 10} textAnchor="end">
                      {fmt(s.values[s.values.length - 1])}
                    </text>
                  )}
                </g>
              );
            })
          : labels.map((l, i) => {
              const bw = Math.min(24, (band * 0.7) / series.length);
              const x0 = PAD.left + band * (i + 0.5) - (bw * series.length + 2 * (series.length - 1)) / 2;
              return series.map((s, si) => {
                const v = s.values[i];
                const top = y(Math.max(v, 0));
                const h = Math.max(1, Math.abs(y(v) - y(0)));
                const x = x0 + si * (bw + 2);
                const r = Math.min(4, h, bw / 2);
                // Rounded at the data end, square at the baseline.
                const d = `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + h} Z`;
                return (
                  <path key={`${i}-${si}`} className={`bar s${si + 1}`} d={d}>
                    <title>{`${l}${s.name ? ` · ${s.name}` : ''}: ${fmt(v, true)}`}</title>
                  </path>
                );
              });
            })}
        {spec.type !== 'line' &&
          series.length === 1 &&
          labels.length <= 8 &&
          series[0].values.map((v, i) => (
            <text key={i} className="value" x={PAD.left + band * (i + 0.5)} y={y(Math.max(v, 0)) - 6} textAnchor="middle">
              {fmt(v)}
            </text>
          ))}
      </svg>
    </figure>
  );
}
