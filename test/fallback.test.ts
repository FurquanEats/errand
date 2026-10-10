import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { addProvider, deleteProvider, fallbackRefs, getModel, listProviders } from '../server/llm.ts';
import { saveSettings } from '../server/settings.ts';
import { startMockModel } from './e2e/mock-model.ts';

// Nothing listens on port 9, so every call fails at once with "connection refused".
const dead = 'http://127.0.0.1:9/v1';

test('fallback order: the chosen model, then other providers, then a sibling', () => {
  const a = addProvider({ kind: 'openai-compatible', name: 'A', baseUrl: dead, models: ['a-pro-2', 'a-flash-2'] });
  const b = addProvider({ kind: 'openai-compatible', name: 'B', baseUrl: dead, models: ['b-large-3', 'b-mini-3'] });
  assert.deepEqual(fallbackRefs(`${a}:a-pro-2`, 'chat'), [`${a}:a-pro-2`, `${b}:b-large-3`, `${a}:a-flash-2`]);
  // Background jobs fall back to fast models.
  assert.deepEqual(fallbackRefs(`${a}:a-flash-2`, 'utility').slice(0, 2), [`${a}:a-flash-2`, `${b}:b-mini-3`]);
});

test('a failed model hands over to a working one and is tried last for a while', async () => {
  for (const p of listProviders()) deleteProvider(p.id); // only this test's providers
  const mock = await startMockModel(4793);
  try {
    const c = addProvider({ kind: 'openai-compatible', name: 'Down', baseUrl: dead, models: ['c-pro-1'] });
    const ok = addProvider({ kind: 'openai-compatible', name: 'Up', baseUrl: 'http://127.0.0.1:4793/v1', models: ['mock-1'] });
    saveSettings({ models: { chat: `${c}:c-pro-1`, handoff: '', utility: '' } });
    const notes: string[] = [];
    const { text } = await generateText({ model: getModel('chat', (from, to) => notes.push(`${from}->${to}`)), prompt: 'hi', maxRetries: 0 });
    assert.ok(text.length > 0, 'the working provider answered');
    assert.ok(
      notes.some((n) => n.startsWith(`${c}:c-pro-1->`)),
      'the switch was reported',
    );
    const order = fallbackRefs(`${c}:c-pro-1`, 'chat');
    assert.notEqual(order[0], `${c}:c-pro-1`, 'the failed model is no longer tried first');
    assert.ok(order.includes(`${ok}:mock-1`));
  } finally {
    mock.close();
  }
});
