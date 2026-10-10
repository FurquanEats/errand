import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vault from '../server/vault.ts';
import { decrypt, deriveKey, encrypt } from '../server/crypto.ts';
import crypto from 'node:crypto';

test('AES-GCM round trip, and tampering is detected', () => {
  const key = deriveKey('correct horse battery staple', crypto.randomBytes(16));
  const sealed = encrypt('hunter22', key);
  assert.equal(decrypt(sealed, key), 'hunter22');
  const tampered = Buffer.from(sealed, 'base64');
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decrypt(tampered.toString('base64'), key));
});

test('vault setup, lock and unlock with the right passphrase only', () => {
  vault.setup('test-passphrase');
  assert.deepEqual(vault.status(), { initialized: true, unlocked: true });
  vault.lock();
  assert.throws(() => vault.unlock('wrong-passphrase'), /Wrong passphrase/);
  vault.unlock('test-passphrase');
  assert.equal(vault.isUnlocked(), true);
});

test('models only ever see tokens; real values are filled server-side and can be redacted', async () => {
  const vid = vault.addItem({ kind: 'login', label: 'Shop', domain: 'https://www.shop.example/login', fields: { username: 'me@x.com', password: 'hunter22' } });
  assert.equal(vault.listItems().find((i) => i.id === vid)?.domain, 'shop.example');
  assert.doesNotMatch(vault.tokenCatalog(), /hunter22/);
  const token = `{{vault:${vid.slice(0, 8)}.password}}`;
  const { text, secrets } = await vault.fillTokens(`pw: ${token}`);
  assert.equal(text, 'pw: hunter22');
  assert.equal(vault.redact(`page shows hunter22`, secrets), 'page shows [REDACTED]');
});

test('the fill guard can refuse a site (logins are bound to their domain)', async () => {
  const vid = vault.listItems()[0].id;
  await assert.rejects(
    vault.fillTokens(`{{vault:${vid.slice(0, 8)}.password}}`, async () => {
      throw new Error('wrong site');
    }),
    /wrong site/,
  );
});

test('revealing requires the passphrase again; editing keeps blank fields', () => {
  const vid = vault.listItems()[0].id;
  assert.throws(() => vault.revealItem(vid, 'nope'), /Wrong passphrase/);
  vault.updateItem(vid, { fields: { username: 'new@x.com', password: '' } });
  assert.deepEqual(vault.revealItem(vid, 'test-passphrase'), { username: 'new@x.com', password: 'hunter22' });
});

test('generated logins have strong passwords and never return the value', () => {
  const { id, tokens } = vault.createLogin('jobs.example', 'me@x.com');
  assert.match(tokens.password, /^\{\{vault:[a-f0-9]{8}\.password\}\}$/);
  const { password } = vault.revealItem(id, 'test-passphrase');
  assert.equal(password.length, 22);
  for (const re of [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/]) assert.match(password, re);
});

test('API keys can only be used once unlocked', () => {
  vault.addItem({ kind: 'api_key', label: 'Strava', fields: { key: 'abc123', base_url: 'https://www.strava.com/api/v3', header: '' } });
  assert.equal(vault.apiKeyFor('strava')?.baseUrl, 'https://www.strava.com/api/v3');
  vault.lock();
  assert.throws(() => vault.apiKeyFor('strava'), /locked/);
});
