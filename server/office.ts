import { marked, type Token, type Tokens } from 'marked';
import { chromium } from 'playwright-core';
import { AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph, TextRun, type ParagraphChild } from 'docx';
import { storeFile, type StoredFile } from './documents.ts';
import { appFontFace } from './font.ts';
import { getSettings } from './settings.ts';

/**
 * Documents in and out. In: the text of PDFs, Word files and text files, so any AI can read what
 * you attach. Out: PDF, Word, HTML, Markdown and CSV made from one Markdown source, so a résumé
 * looks the same in every format.
 */

// ── Reading ────────────────────────────────────────────────────────────────

export async function readDocument(name: string, mediaType: string, data: Buffer): Promise<string | null> {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  try {
    if (mediaType === 'application/pdf' || ext === 'pdf') {
      const { extractText, getDocumentProxy } = await import('unpdf');
      return String((await extractText(await getDocumentProxy(new Uint8Array(data)), { mergePages: true })).text).trim();
    }
    if (ext === 'docx' || mediaType.includes('wordprocessingml')) {
      const mammoth = await import('mammoth');
      return (await mammoth.extractRawText({ buffer: data })).value.trim();
    }
    if (mediaType.startsWith('text/') || /json|xml|csv|markdown/.test(mediaType) || ['md', 'txt', 'csv', 'json', 'html'].includes(ext))
      return data.toString('utf8');
  } catch {
    return null; // a damaged or protected file: the AI still gets the file itself
  }
  return null;
}

// ── Making ─────────────────────────────────────────────────────────────────

export type DocStyle = 'document' | 'resume' | 'letter';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A clean, printable page: paper-white, ink type, generous but compact for a résumé. */
function html(title: string, markdown: string, style: DocStyle, scale = 1) {
  const tight = style === 'resume';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
${appFontFace()}
@page{size:A4;margin:${tight ? '14mm 15mm' : '20mm 20mm'}}
*{box-sizing:border-box}html{font:${tight ? '10pt/1.38' : '11pt/1.55'} 'Host Grotesk Variable','Segoe UI',Arial,sans-serif;color:#1a1917;-webkit-print-color-adjust:exact}
body{margin:0;max-width:${tight ? 'none' : '170mm'}}
@media screen{body{margin:32px auto;padding:0 32px;max-width:${tight ? '210mm' : '190mm'}}}
${scale < 1 ? `@media print{html{zoom:${scale}}}` : ''}
h1{font-size:${tight ? '20pt' : '22pt'};letter-spacing:-.02em;margin:0 0 ${tight ? '2pt' : '6pt'};line-height:1.1}
h1+p{color:#57534b;margin-top:0}
h2{font-size:${tight ? '10.5pt' : '13pt'};text-transform:${tight ? 'uppercase' : 'none'};letter-spacing:${tight ? '.06em' : '-.01em'};margin:${tight ? '10pt 0 4pt' : '16pt 0 6pt'};padding-bottom:2pt;border-bottom:${tight ? '.6pt solid #c9c2b4' : '0'}}
h3{font-size:${tight ? '10.5pt' : '11.5pt'};margin:${tight ? '6pt 0 1pt' : '12pt 0 4pt'}}
p{margin:0 0 ${tight ? '4pt' : '8pt'}}ul,ol{margin:0 0 ${tight ? '4pt' : '8pt'};padding-left:${tight ? '13pt' : '18pt'}}li{margin:${tight ? '1pt' : '2pt'} 0}
a{color:#1a1917}hr{border:0;border-top:.6pt solid #c9c2b4;margin:8pt 0}
table{border-collapse:collapse;width:100%;margin:0 0 8pt}th,td{text-align:left;padding:3pt 6pt 3pt 0;border-bottom:.6pt solid #ddd7cb;vertical-align:top}
code{font-family:Consolas,monospace;font-size:.92em}blockquote{margin:0 0 8pt;padding-left:10pt;border-left:2pt solid #ddd7cb;color:#57534b}
</style></head><body>${marked.parse(markdown, { async: false })}</body></html>`;
}

async function pdf(pages: string[]): Promise<{ buffer: Buffer; pages: number; tried: number }> {
  const h = getSettings().handoff;
  const channel = h.browserChannel === 'chromium' || h.browserChannel === 'remote' || h.browserChannel === 'custom' ? undefined : h.browserChannel;
  const launch = (ch?: string) =>
    chromium.launch({ headless: true, channel: ch, executablePath: h.browserChannel === 'custom' && h.executablePath ? h.executablePath : undefined });
  const browser = await launch(channel).catch(() => launch(process.platform === 'win32' ? 'msedge' : 'chrome'));
  try {
    // Each version is a little tighter than the last; the first that fits one page wins.
    const { getDocumentProxy } = await import('unpdf');
    const tab = await browser.newPage();
    let best: { buffer: Buffer; pages: number; tried: number } | null = null;
    for (const [i, page] of pages.entries()) {
      await tab.setContent(page, { waitUntil: 'load' });
      await tab.evaluate(() => document.fonts.ready);
      const buffer = await tab.pdf({ preferCSSPageSize: true, printBackground: true });
      const count = (await getDocumentProxy(new Uint8Array(buffer))).numPages;
      best = { buffer, pages: count, tried: i };
      if (count === 1) break;
    }
    return best!;
  } finally {
    await browser.close();
  }
}

// Markdown inline tokens → Word runs.
function runs(tokens: Token[] | undefined, fmt: { bold?: boolean; italics?: boolean } = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const t of tokens ?? []) {
    if (t.type === 'strong') out.push(...runs((t as Tokens.Strong).tokens, { ...fmt, bold: true }));
    else if (t.type === 'em') out.push(...runs((t as Tokens.Em).tokens, { ...fmt, italics: true }));
    else if (t.type === 'link')
      out.push(
        new ExternalHyperlink({ link: (t as Tokens.Link).href, children: [new TextRun({ text: (t as Tokens.Link).text, style: 'Hyperlink', ...fmt })] }),
      );
    else if (t.type === 'codespan') out.push(new TextRun({ text: (t as Tokens.Codespan).text, font: 'Consolas', ...fmt }));
    else if (t.type === 'br') out.push(new TextRun({ text: '', break: 1 }));
    else if ('tokens' in t && t.tokens) out.push(...runs(t.tokens as Token[], fmt));
    else
      out.push(
        new TextRun({
          text:
            'text' in t
              ? String(t.text)
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
              : '',
          ...fmt,
        }),
      );
  }
  return out;
}

async function docx(markdown: string, style: DocStyle, scale = 1): Promise<Buffer> {
  const tight = style === 'resume';
  const body: Paragraph[] = [];
  const list = (l: Tokens.List, depth = 0) => {
    for (const item of l.items)
      for (const t of item.tokens) {
        if (t.type === 'list') list(t as Tokens.List, depth + 1);
        else
          body.push(
            new Paragraph({
              children: runs((t as Tokens.Text).tokens ?? [t]),
              numbering: { reference: l.ordered ? 'numbers' : 'bullets', level: depth },
              spacing: { after: tight ? 20 : 60 },
            }),
          );
      }
  };
  for (const t of marked.lexer(markdown)) {
    if (t.type === 'heading') {
      const h = t as Tokens.Heading;
      body.push(
        new Paragraph({
          heading: h.depth === 1 ? HeadingLevel.TITLE : h.depth === 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
          children: runs(h.tokens),
          ...(h.depth === 2 && tight ? { border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C9C2B4', space: 1 } } } : {}),
        }),
      );
    } else if (t.type === 'paragraph') body.push(new Paragraph({ children: runs((t as Tokens.Paragraph).tokens), spacing: { after: tight ? 60 : 140 } }));
    else if (t.type === 'list') list(t as Tokens.List);
    else if (t.type === 'hr') body.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C9C2B4', space: 1 } } }));
    else if (t.type === 'table') {
      const tb = t as Tokens.Table;
      body.push(
        new Paragraph({
          children: runs(
            tb.header.flatMap((c, i) => [...(i ? [{ type: 'text', raw: ' · ', text: ' · ' } as Token] : []), ...c.tokens]),
            { bold: true },
          ),
        }),
      );
      for (const row of tb.rows)
        body.push(new Paragraph({ children: runs(row.flatMap((c, i) => [...(i ? [{ type: 'text', raw: ' · ', text: ' · ' } as Token] : []), ...c.tokens])) }));
    } else if (t.type === 'blockquote' || t.type === 'code')
      body.push(new Paragraph({ children: [new TextRun({ text: (t as Tokens.Code).text, italics: t.type === 'blockquote' })] }));
  }
  const font = 'Calibri';
  const size = Math.round((tight ? 20 : 22) * scale); // half-points
  const doc = new Document({
    styles: {
      default: { document: { run: { font, size, color: '1A1917' } } },
      paragraphStyles: [
        {
          id: 'Title',
          name: 'Title',
          run: { font, size: Math.round((tight ? 40 : 44) * scale), bold: true },
          paragraph: { spacing: { after: tight ? 40 : 120 } },
        },
        {
          id: 'Heading1',
          name: 'Heading 1',
          run: { font, size: Math.round((tight ? 21 : 26) * scale), bold: true, allCaps: tight },
          paragraph: { spacing: { before: tight ? 180 : 280, after: tight ? 60 : 100 } },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          run: { font, size: Math.round((tight ? 21 : 23) * scale), bold: true },
          paragraph: { spacing: { before: tight ? 100 : 200, after: 20 } },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: 'bullets',
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: '•',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 280 + level * 280, hanging: 200 } } },
          })),
        },
        {
          reference: 'numbers',
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360 + level * 280, hanging: 260 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: { page: { margin: tight ? { top: 790, bottom: 790, left: 850, right: 850 } : { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        children: body,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

// A résumé that runs a little long is tightened (down to 85%, still easy to read) to fit one page.
const FIT = [1, 0.95, 0.9, 0.85];

export async function makeDocument(o: {
  title: string;
  format: 'pdf' | 'docx' | 'html' | 'md' | 'csv';
  content: string;
  style?: DocStyle;
  scale?: number;
}): Promise<{ file: StoredFile; pages?: number; scale?: number }> {
  const style = o.style ?? 'document';
  const base =
    o.title
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 80) || 'Document';
  switch (o.format) {
    case 'pdf': {
      const scales = style === 'resume' ? FIT : [1];
      const out = await pdf(scales.map((k) => html(o.title, o.content, style, k)));
      return { file: storeFile(`${base}.pdf`, out.buffer), pages: out.pages, scale: scales[out.tried] };
    }
    case 'docx':
      return { file: storeFile(`${base}.docx`, await docx(o.content, style, o.scale ?? 1)) };
    case 'html':
      return { file: storeFile(`${base}.html`, html(o.title, o.content, style)) };
    case 'csv':
      return { file: storeFile(`${base}.csv`, o.content) };
    default:
      return { file: storeFile(`${base}.md`, o.content) };
  }
}
