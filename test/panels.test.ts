import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPanel, type PanelRow } from '../server/panels.ts';

const panel = (data: string | null): PanelRow => ({
  id: 'p',
  title: 'Test',
  request: 'test',
  html: '<div id=v></div>',
  data_prompt: '',
  data,
  error: null,
  refresh_minutes: 60,
  size: 'md',
  position: 0,
  refreshed_at: null,
  created_at: 0,
});

test('panel frames carry the app font inline, since their CSP only allows data: fonts', () => {
  const html = renderPanel(panel('{}'), 'light');
  assert.match(html, /@font-face\{font-family:'Host Grotesk Variable'[^}]*src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}\)/);
});

test('panel data cannot close its script tag', () => {
  const html = renderPanel(panel('{"x":"</script><script>alert(1)</script>"}'));
  assert.equal(html.match(/<\/script>/g)?.length, 1);
});
