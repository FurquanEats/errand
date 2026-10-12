import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyKey } from '../server/trackers.ts';

test('the same employer is one company, however its name is written', () => {
  assert.equal(companyKey('Abstrabit Technologies Pvt Ltd'), companyKey('Abstrabit'));
  assert.equal(companyKey('Vivify Healthcare Pvt. Ltd.'), 'vivifyhealthcare');
  assert.equal(companyKey('Redule Ai'), companyKey('Redule'));
  assert.equal(companyKey('Superserve Inc.'), 'superserve');
  assert.notEqual(companyKey('Mem0'), companyKey('Mem'));
  // A one-word name is never stripped to nothing.
  assert.equal(companyKey('Labs'), 'labs');
});
