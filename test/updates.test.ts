import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceUpdate, newer, VERSION } from '../server/updates.ts';
import { getKV, setKV } from '../server/settings.ts';
import { insert, run } from '../server/db.ts';

test('release versions compare numerically', () => {
  assert.equal(newer('0.1.10', '0.1.9'), true);
  assert.equal(newer('0.2.0', '0.1.9'), true);
  assert.equal(newer('0.1.3', '0.1.3'), false);
  assert.equal(newer('0.1.2', '0.1.3'), false);
  assert.equal(newer('1.0', '0.9.9'), true);
});

test("what's new is posted once after an update, never on a fresh install", () => {
  const posts: string[] = [];
  const post = (t: string) => posts.push(t);
  announceUpdate(post); // fresh install: nothing seen yet
  assert.equal(posts.length, 0);
  setKV('version.seen', '0.0.1');
  announceUpdate(post);
  announceUpdate(post);
  assert.equal(posts.length, 1);
  assert.match(posts[0], new RegExp(`updated to \\*\\*${VERSION.replace(/\./g, '\\.')}\\*\\*`));
});

test('after an update, the highlights are what changed, not the overview', () => {
  setKV('version.seen', '0.0.1');
  const posts: string[] = [];
  announceUpdate((t) => posts.push(t));
  assert.match(posts[0], /New: /);
  assert.doesNotMatch(posts[0], /Notices things on its own/);
});

test('an install from before version tracking still hears what is new', () => {
  run("DELETE FROM settings WHERE key = 'version.seen'");
  insert('conversations', { id: 'c-old', title: 'Errand', project_id: null, created_at: 1, updated_at: 1 });
  insert('messages', { id: 'm-old', conversation_id: 'c-old', role: 'user', content: '[]', kind: 'normal', created_at: 1 });
  const posts: string[] = [];
  announceUpdate((t) => posts.push(t));
  assert.equal(posts.length, 1);
  assert.equal(getKV('version.seen'), VERSION);
});
