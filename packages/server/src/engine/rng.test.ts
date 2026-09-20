import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, pickOne, shuffle } from './rng.ts';

describe('rng', () => {
  test('is deterministic for a given seed', () => {
    const a = createRng(123);
    const b = createRng(123);
    const runA = Array.from({ length: 50 }, () => a());
    const runB = Array.from({ length: 50 }, () => b());
    assert.deepEqual(runA, runB);
  });

  test('different seeds diverge', () => {
    assert.notEqual(createRng(1)(), createRng(2)());
  });

  test('stays in [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const n = rng();
      assert.ok(n >= 0 && n < 1, `out of range: ${n}`);
    }
  });

  test('shuffle preserves every element and does not mutate the input', () => {
    const input = Array.from({ length: 60 }, (_, i) => i);
    const frozen = [...input];
    const out = shuffle(input, createRng(5));
    assert.deepEqual(input, frozen, 'input was mutated');
    assert.equal(out.length, input.length);
    assert.deepEqual([...out].sort((a, b) => a - b), frozen);
  });

  test('shuffle actually reorders', () => {
    const input = Array.from({ length: 60 }, (_, i) => i);
    assert.notDeepEqual(shuffle(input, createRng(5)), input);
  });

  test('shuffle handles empty and single-element arrays', () => {
    assert.deepEqual(shuffle([], createRng(1)), []);
    assert.deepEqual(shuffle(['a'], createRng(1)), ['a']);
  });

  test('pickOne returns a member and rejects an empty array', () => {
    const items = ['a', 'b', 'c'];
    assert.ok(items.includes(pickOne(items, createRng(3))));
    assert.throws(() => pickOne([], createRng(1)));
  });
});
