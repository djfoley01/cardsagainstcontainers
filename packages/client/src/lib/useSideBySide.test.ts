import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSideBySide, type FitInput } from './useSideBySide.ts';

/** A roomy desktop where the stack fits comfortably. */
const base: FitInput = {
  viewportWidth: 1440,
  viewportHeight: 1200,
  firstHeight: 420,
  secondHeight: 280,
  current: false,
};

describe('landing page layout', () => {
  test('stacks when there is vertical room', () => {
    assert.equal(shouldSideBySide(base), false);
  });

  test('goes side by side when the stack would overflow', () => {
    // 420 + 280 + 220 chrome = 920, taller than the window.
    assert.equal(shouldSideBySide({ ...base, viewportHeight: 800 }), true);
  });

  test('never uses two columns on a narrow screen, however short', () => {
    // The phone case: scrolling is accepted, a two-column layout is not.
    for (const height of [900, 700, 500, 380]) {
      assert.equal(
        shouldSideBySide({ ...base, viewportWidth: 390, viewportHeight: height }),
        false,
        `390x${height} should stay stacked`,
      );
    }
  });

  test('stays stacked just below the width threshold and switches just above', () => {
    const short = { ...base, viewportHeight: 700 };
    assert.equal(shouldSideBySide({ ...short, viewportWidth: 959 }), false);
    assert.equal(shouldSideBySide({ ...short, viewportWidth: 960 }), true);
  });

  test('does nothing until there is a second panel to place', () => {
    // No leaderboard yet: nobody has won a round, so the panel is empty.
    assert.equal(shouldSideBySide({ ...base, viewportHeight: 600, secondHeight: 0 }), false);
  });

  test('a growing leaderboard can tip a fitting layout into two columns', () => {
    const tall = { ...base, viewportHeight: 900 };
    assert.equal(shouldSideBySide({ ...tall, secondHeight: 200 }), false);
    // Six more winners appear and the stack no longer fits.
    assert.equal(shouldSideBySide({ ...tall, secondHeight: 400 }), true);
  });
});

describe('hysteresis', () => {
  test('does not flip back the instant the stack nominally fits', () => {
    // Exactly at the boundary: 420 + 280 + 220 = 920.
    const atBoundary = { ...base, viewportHeight: 920, current: true };
    assert.equal(shouldSideBySide(atBoundary), true, 'should hold the row layout in the deadband');
  });

  test('flips back once the stack fits with room to spare', () => {
    assert.equal(shouldSideBySide({ ...base, viewportHeight: 1000, current: true }), false);
  });

  test('the deadband is asymmetric, which is the point', () => {
    // One height, two answers, depending on where you came from. That is what
    // stops a window dragged to the threshold from flickering.
    const height = 900;
    assert.equal(shouldSideBySide({ ...base, viewportHeight: height, current: false }), true);
    assert.equal(shouldSideBySide({ ...base, viewportHeight: height, current: true }), true);

    const settled = 930;
    assert.equal(shouldSideBySide({ ...base, viewportHeight: settled, current: false }), false);
    assert.equal(shouldSideBySide({ ...base, viewportHeight: settled, current: true }), true);
  });

  test('repeated evaluation at one size is stable', () => {
    // Feed the answer back in as the new current state; it must settle.
    let current = false;
    const seen: boolean[] = [];
    for (let i = 0; i < 12; i++) {
      current = shouldSideBySide({ ...base, viewportHeight: 880, current });
      seen.push(current);
    }
    assert.equal(new Set(seen.slice(1)).size, 1, `oscillated: ${seen.join(',')}`);
  });
});
