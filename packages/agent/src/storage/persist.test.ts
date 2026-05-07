import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonStringify, sha256Hex } from '../utils/canonical-json';

test('canonicalJsonStringify sorts nested object keys and stringifies bigint', () => {
  const input = {
    z: 1,
    nested: {
      b: 2n,
      a: 'alpha',
    },
    arr: [{ y: 2, x: 1 }],
  };

  const output = canonicalJsonStringify(input);

  assert.equal(
    output,
    '{"arr":[{"x":1,"y":2}],"nested":{"a":"alpha","b":"2"},"z":1}'
  );
});

test('sha256Hex is stable for equivalent differently ordered payloads', () => {
  const left = { b: 2, a: { y: 3, x: 1 } };
  const right = { a: { x: 1, y: 3 }, b: 2 };

  assert.equal(sha256Hex(left), sha256Hex(right));
});
