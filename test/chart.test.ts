import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChart } from '../web/components/Chart.tsx';

test('chart specs from the model are validated', () => {
  const ok = parseChart('{"type":"line","labels":["a","b"],"series":[{"name":"x","values":[1,"2"]}]}');
  assert.deepEqual(ok?.series[0].values, [1, 2]);
  assert.equal(ok?.type, 'line');
  assert.deepEqual(parseChart('{"labels":["a"],"values":[5]}')?.series, [{ name: undefined, values: [5] }]);
  assert.equal(parseChart('{"labels":["a","b"],"values":[1]}'), null, 'lengths must match');
  assert.equal(parseChart('{"labels":["a"],"values":["x"]}'), null, 'values must be numbers');
  assert.equal(parseChart('not json'), null);
});
