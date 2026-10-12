import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyKey, groupNews } from '../server/trackers.ts';

test('the same employer is one company, however its name is written', () => {
  assert.equal(companyKey('Abstrabit Technologies Pvt Ltd'), companyKey('Abstrabit'));
  assert.equal(companyKey('Vivify Healthcare Pvt. Ltd.'), 'vivifyhealthcare');
  assert.equal(companyKey('Redule Ai'), companyKey('Redule'));
  assert.equal(companyKey('Superserve Inc.'), 'superserve');
  assert.notEqual(companyKey('Mem0'), companyKey('Mem'));
  // A one-word name is never stripped to nothing.
  assert.equal(companyKey('Labs'), 'labs');
});

test('many changes of one kind share a line; single ones keep theirs', () => {
  const job = (name: string) => ({
    line: `${name} moved your application to **Assessment**`,
    group: 'jobs:assessment',
    many: 'applications moved to **Assessment**',
    name,
  });
  const lines = groupNews([
    job('Linear'),
    { line: 'CI failed on **acme/shop**', group: 'ci', many: 'CI failures', name: 'acme/shop' },
    job('Vercel'),
    job('Figma'),
    job('Raycast'),
    job('Linear'),
  ]);
  assert.deepEqual(lines, ['4 applications moved to **Assessment**: Linear, Vercel, Figma and 1 more', 'CI failed on **acme/shop**']);
  assert.deepEqual(groupNews([job('Linear'), job('Vercel')]), ['2 applications moved to **Assessment**: Linear and Vercel']);
  assert.deepEqual(groupNews([job('Linear')]), ['Linear moved your application to **Assessment**']);
});
