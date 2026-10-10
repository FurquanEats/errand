import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSettings } from '../server/settings.ts';
import { microsoftAuthUrl, microsoftCallback, microsoftConfigured, microsoftRedirectUri } from '../server/connectors/microsoft.ts';

test('Microsoft sign-in is a PKCE public-client request for IMAP and SMTP', () => {
  saveSettings({ microsoft: { clientId: '' } });
  assert.equal(microsoftConfigured(), false);
  assert.throws(() => microsoftAuthUrl(), /not set up/);

  saveSettings({ microsoft: { clientId: 'test-client' } });
  const url = new URL(microsoftAuthUrl('sam@outlook.com'));
  const q = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(q.get('client_id'), 'test-client');
  assert.equal(q.get('redirect_uri'), microsoftRedirectUri());
  assert.match(microsoftRedirectUri(), /^http:\/\/localhost:\d+\/api\/oauth\/microsoft\/callback$/);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge') ?? '', /^[\w-]{43}$/);
  assert.equal(q.get('client_secret'), null);
  for (const scope of ['offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'])
    assert.ok(q.get('scope')?.split(' ').includes(scope), scope);
  assert.equal(q.get('login_hint'), 'sam@outlook.com');
});

test('a Microsoft callback needs a sign-in that was started here', async () => {
  await assert.rejects(microsoftCallback('code', 'forged-state'), /not started here/);
});
