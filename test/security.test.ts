import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isAllowedHost, isOwnOrigin, isUnder, redactSecrets } from '../server/security.ts';

test('only loopback names, IP literals and configured hosts are allowed (DNS rebinding defence)', () => {
  assert.equal(isAllowedHost('localhost'), true);
  assert.equal(isAllowedHost('app.localhost'), true);
  assert.equal(isAllowedHost('127.0.0.1'), true);
  assert.equal(isAllowedHost('192.168.1.20'), true);
  assert.equal(isAllowedHost('[::1]'), true);
  assert.equal(isAllowedHost('evil.example.com'), false);
  assert.equal(isAllowedHost('localhost.evil.com'), false);
  assert.equal(isAllowedHost('my-pc.tail1234.ts.net'), true); // Tailscale, for phones
  assert.equal(isAllowedHost('ts.net.evil.com'), false);
});

test('model-chosen URLs cannot reach local or private networks (SSRF)', async () => {
  for (const url of [
    'http://127.0.0.1:4747/api/vault',
    'http://localhost/',
    'http://10.0.0.5/',
    'http://192.168.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'file:///etc/passwd',
  ]) {
    await assert.rejects(assertPublicUrl(url), undefined, url);
  }
  await assert.doesNotReject(assertPublicUrl('http://93.184.216.34/'));
});

test("the browser agent may not open Errand's own API", () => {
  assert.equal(isOwnOrigin('http://localhost:4747/api/vault/items'), true);
  assert.equal(isOwnOrigin('http://127.0.0.1:4747/'), true);
  assert.equal(isOwnOrigin('http://localhost:4800/shop'), false);
  assert.equal(isOwnOrigin('https://example.com:4747/'), false);
});

test('credentials in tool results are blocked before reaching the model', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const out = redactSecrets({ page: `token=${jwt}`, keys: ['sk-proj-abcdefghijklmnopqrstuvwxyz123456', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'], n: 4 });
  assert.match(out.page, /\[BLOCKED: JWT token\]/);
  assert.doesNotMatch(JSON.stringify(out), /eyJhbGci|sk-proj-abc|ghp_abc/);
  assert.equal(out.n, 4);
  assert.equal(redactSecrets('{{vault:ab12cd34.password}}'), '{{vault:ab12cd34.password}}');
});

test('an API key only goes to the site it was saved for', () => {
  assert.equal(isUnder('https://api.example.com/v1/items', 'https://api.example.com'), true);
  assert.equal(isUnder('https://api.example.com/v1/items', 'https://api.example.com/v1'), true);
  assert.equal(isUnder('https://api.example.com/v1', 'https://api.example.com/v1/'), true);
  assert.equal(isUnder('https://api.example.com.evil.com/x', 'https://api.example.com'), false);
  assert.equal(isUnder('https://api.example.com@evil.com/x', 'https://api.example.com'), false);
  assert.equal(isUnder('https://api.example.com/v10/x', 'https://api.example.com/v1'), false);
  assert.equal(isUnder('http://api.example.com/v1', 'https://api.example.com'), false);
  assert.equal(isUnder('not a url', 'https://api.example.com'), false);
});
