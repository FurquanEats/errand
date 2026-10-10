import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.ts';
import { appFontFace } from './font.ts';

/**
 * Files Errand produces or collects: presentations it builds, screenshots and downloads from
 * the browser agent (receipts, return labels, QR codes). Served back through /api/files/:id.
 */

const DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(DIR, { recursive: true });

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.ics': 'text/calendar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function storeFile(name: string, data: Buffer | string): StoredFile {
  const safe = name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
  const fid = crypto.randomUUID();
  const file = path.join(DIR, `${fid}__${safe}`);
  fs.writeFileSync(file, data);
  return {
    id: fid,
    name: safe,
    mime: MIME[path.extname(safe).toLowerCase()] ?? 'application/octet-stream',
    size: fs.statSync(file).size,
    url: `/api/files/${fid}`,
  };
}

export function readStoredFile(fid: string): { path: string; name: string; mime: string } | null {
  if (!/^[0-9a-f-]{36}$/.test(fid)) return null;
  const match = fs.readdirSync(DIR).find((f) => f.startsWith(`${fid}__`));
  if (!match) return null;
  const name = match.slice(fid.length + 2);
  return { path: path.join(DIR, match), name, mime: MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream' };
}

/** Files the user has given Errand or Errand has made, newest first (for the browser agent to upload). */
export function listStoredFiles(limit = 20): StoredFile[] {
  return fs
    .readdirSync(DIR)
    .map((f) => ({ f, at: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((x, y) => y.at - x.at)
    .slice(0, limit)
    .map(({ f }) => {
      const [fid, name = f] = f.split('__');
      return {
        id: fid,
        name,
        mime: MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
        size: fs.statSync(path.join(DIR, f)).size,
        url: `/api/files/${fid}`,
      };
    });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface Slide {
  title: string;
  subtitle?: string;
  bullets?: string[];
  chart?: { type: 'bar' | 'line'; labels: string[]; values: number[]; unit?: string };
  stat?: { value: string; label: string };
}

/** A self-contained, keyboard-navigable slide deck (←/→) in Errand's look: paper, ink and one signal. */
export function buildPresentation(title: string, slides: Slide[]): StoredFile {
  const chart = (c: NonNullable<Slide['chart']>) => {
    const max = Math.max(...c.values, 1);
    const w = 900;
    const h = 360;
    const step = w / c.values.length;
    if (c.type === 'line') {
      const pts = c.values.map((v, i) => `${i * step + step / 2},${h - (v / max) * (h - 40)}`).join(' ');
      return `<svg viewBox="0 0 ${w} ${h + 40}" class="chart"><polyline points="${pts}" fill="none" stroke="#1a1917" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>${c.values
        .map(
          (v, i) =>
            `<circle cx="${i * step + step / 2}" cy="${h - (v / max) * (h - 40)}" r="7" fill="${i === c.values.length - 1 ? '#e2531f' : '#1a1917'}"/><text x="${i * step + step / 2}" y="${h + 32}" text-anchor="middle">${esc(c.labels[i] ?? '')}</text>`,
        )
        .join('')}</svg>`;
    }
    return `<svg viewBox="0 0 ${w} ${h + 40}" class="chart">${c.values
      .map((v, i) => {
        const bh = (v / max) * (h - 40);
        return `<rect x="${i * step + step * 0.18}" y="${h - bh}" width="${step * 0.64}" height="${bh}" rx="6" fill="#1a1917"/><text x="${i * step + step / 2}" y="${h - bh - 12}" text-anchor="middle" class="v">${v}${esc(c.unit ?? '')}</text><text x="${i * step + step / 2}" y="${h + 32}" text-anchor="middle">${esc(c.labels[i] ?? '')}</text>`;
      })
      .join('')}</svg>`;
  };
  const body = slides
    .map(
      (s, i) => `<section class="slide${i === 0 ? ' active' : ''}">
  <h1>${esc(s.title)}</h1>${s.subtitle ? `<h2>${esc(s.subtitle)}</h2>` : ''}
  ${s.stat ? `<div class="stat"><div class="sv">${esc(s.stat.value)}</div><div class="sl">${esc(s.stat.label)}</div></div>` : ''}
  ${s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
  ${s.chart ? chart(s.chart) : ''}
</section>`,
    )
    .join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
${appFontFace()}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#f2efe8;color:#1a1917;font-family:'Host Grotesk Variable',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.slide{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center;padding:8vh 10vw}.slide.active{display:flex}
h1{font-size:clamp(32px,5.5vw,76px);letter-spacing:-.045em;line-height:1.02;margin:0 0 .35em;font-weight:650}h1::after{content:'.';color:#e2531f}h2{font-size:clamp(18px,2.3vw,30px);color:#57534b;font-weight:400;margin:0 0 1.2em;letter-spacing:-.01em}
ul{font-size:clamp(18px,2.1vw,30px);line-height:1.45;padding:0;margin:0;list-style:none;max-width:44ch}li{padding:.45em 0;border-top:1px solid #ddd7cb}li:last-child{border-bottom:1px solid #ddd7cb}
.stat .sv{font-size:clamp(72px,13vw,180px);font-weight:600;letter-spacing:-.06em;line-height:.9}.stat .sl{font-size:clamp(18px,2vw,26px);color:#57534b;margin-top:.4em}
.chart{width:100%;max-height:55vh}.chart text{fill:#6f695e;font-size:22px;font-family:inherit}.chart .v{fill:#1a1917;font-weight:600}
nav{position:fixed;bottom:22px;right:28px;color:#6f695e;font-size:14px}
</style></head><body>${body}<nav><span id="n">1</span> / ${slides.length} · ← →</nav>
<script>let i=0;const s=[...document.querySelectorAll('.slide')];const go=d=>{s[i].classList.remove('active');i=Math.max(0,Math.min(s.length-1,i+d));s[i].classList.add('active');document.getElementById('n').textContent=i+1};
addEventListener('keydown',e=>{if(['ArrowRight',' ','PageDown'].includes(e.key))go(1);if(['ArrowLeft','PageUp'].includes(e.key))go(-1)});addEventListener('click',e=>go(e.clientX>innerWidth/3?1:-1));</script></body></html>`;
  return storeFile(`${title}.html`, html);
}
