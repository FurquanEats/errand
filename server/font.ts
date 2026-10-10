import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Panels and presentations are sandboxed (their CSP only allows data: fonts), so the app's typeface
// is inlined. Without it they fall back to the system font and don't match the rest of Errand.
let fontFace: string | undefined;
export function appFontFace() {
  if (fontFace === undefined) {
    try {
      const file = createRequire(import.meta.url).resolve('@fontsource-variable/host-grotesk/files/host-grotesk-latin-wght-normal.woff2');
      fontFace = `@font-face{font-family:'Host Grotesk Variable';font-style:normal;font-display:block;font-weight:300 800;src:url(data:font/woff2;base64,${readFileSync(file).toString('base64')}) format('woff2')}`;
    } catch {
      fontFace = '';
    }
  }
  return fontFace;
}
