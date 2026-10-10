import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Chart, parseChart, type ChartSpec } from './Chart';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Headings in a reply sit under the page's own heading, so they're all level 2 (they look the same anyway).
const html = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string).replace(/<(\/?)h[1-6]\b/g, '<$1h2');

type Part = { md: string } | { chart: ChartSpec } | { drawing: true };

/** Splits out ```chart blocks; an unfinished one (still streaming) shows a placeholder. */
function split(text: string): Part[] {
  const parts: Part[] = [];
  const re = /```chart[^\n]*\n([\s\S]*?)(```|$)/g;
  let at = 0;
  for (let m; (m = re.exec(text));) {
    if (m.index > at) parts.push({ md: text.slice(at, m.index) });
    const spec = m[2] ? parseChart(m[1]) : null;
    parts.push(spec ? { chart: spec } : m[2] ? { md: '```json\n' + m[1] + '```' } : { drawing: true });
    at = m.index + m[0].length;
    if (!m[0]) break;
  }
  if (at < text.length) parts.push({ md: text.slice(at) });
  return parts;
}

export function Markdown({ text }: { text: string }) {
  const parts = useMemo(() => split(text), [text]);
  return (
    <div className="md">
      {parts.map((p, i) =>
        'chart' in p ? (
          <Chart key={i} spec={p.chart} />
        ) : 'drawing' in p ? (
          <div key={i} className="chart-drawing">
            <span className="spinner" /> Drawing a chart…
          </div>
        ) : (
          <div key={i} dangerouslySetInnerHTML={{ __html: html(p.md) }} />
        ),
      )}
    </div>
  );
}
