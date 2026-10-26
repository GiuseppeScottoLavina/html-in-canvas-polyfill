// Where the harness puts the OS pointer out of the test browser's windows (test/harness/lib/os-pointer.mjs parkingSpot): never over a window, away from
// the screen edges, and nowhere when the windows cover every display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parkingSpot } from '../../harness/lib/os-pointer.mjs';

const inside = (p, r) => p.x >= r.left && p.x < r.left + r.width && p.y >= r.top && p.y < r.top + r.height;
const screen = { left: 0, top: 0, width: 1800, height: 1169 };

test('a 1400x900 window at the top left of a 1800x1169 screen: the band at its right, vertically centred', () => {
  const win = { left: 0, top: 39, width: 1400, height: 900 };
  const p = parkingSpot([win], [screen]);
  assert.deepEqual(p, { x: 1600, y: 585 });
  assert.equal(inside(p, win), false);
});

test('a window as wide as the screen: the band below it', () => {
  const win = { left: 0, top: 39, width: 1800, height: 900 };
  const p = parkingSpot([win], [screen]);
  assert.ok(p && !inside(p, win) && p.y > 939 && p.y < 1169 && p.x === 900, JSON.stringify(p));
});

test('several windows of the browser are avoided together, and a second display is used when the first is covered', () => {
  const wins = [{ left: 0, top: 39, width: 1400, height: 900 }, { left: 1300, top: 39, width: 500, height: 1130 }];
  const second = { left: 1800, top: 0, width: 1440, height: 900 };
  const p = parkingSpot(wins, [screen, second]);
  assert.ok(p && wins.every((w) => !inside(p, w)) && p.x >= 1800, JSON.stringify(p));
});

test('windows covering every display: no spot (the pointer guard reports any input the resting pointer sends)', () => {
  assert.equal(parkingSpot([{ left: 0, top: 0, width: 1800, height: 1169 }], [screen]), null);
  // a sliver narrower than the margins is no spot either
  assert.equal(parkingSpot([{ left: 0, top: 0, width: 1780, height: 1169 }], [screen]), null);
});
