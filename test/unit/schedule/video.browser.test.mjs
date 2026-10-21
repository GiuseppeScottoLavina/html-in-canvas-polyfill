// Playing <video> inside a drawable: a damage per new video frame (WPT video: one paint per frame), nothing while nothing plays.
import { test, assert, sleep } from '/test/unit/lib/t.js';
import { createRig } from './_dom.js';
import { observeVideos } from '/src/schedule/observers/video-observer.js';

// rgb100.webm: three frames (red, green, blue) at 5 fps, looped
const PAGE = '<div drawable id="d" style="width:100px"><video id="v" width="100" height="100" src="/test/vendor/wpt/media/rgb100.webm" muted loop></video></div>';
const runHooks = (rig) => { let keep = false; for (const hook of [...rig.sink.hooks]) if (hook(performance.now(), { frameCap: 0, due: true }) === true) keep = true; return keep; };

test('a playing video damages its drawable once per presented frame (5 fps: about 6 in 1.2 s, not one per display frame); paused, it damages nothing', async (t) => {
  const rig = createRig({ html: PAGE });
  const v = /** @type {HTMLVideoElement} */ (rig.layerEl.querySelector('#v'));
  t.cleanup(observeVideos(rig.env, rig.record));
  for (let i = 0; i < 100 && v.readyState < 2; i++) await sleep(10);
  await sleep(50);
  assert.ok(rig.sink.damage.length <= 1, 'the first frame loaded: one damage at most');
  rig.sink.clear();
  await sleep(300);
  assert.equal(rig.sink.damage.length, 0, 'not playing: nothing');
  await v.play();
  rig.sink.clear();
  await sleep(1200);
  const n = rig.sink.damage.length;
  assert.ok(n >= 4 && n <= 9, `about one damage per video frame (6 frames in 1.2 s): ${n}`);
  assert.ok(rig.sink.damage.every((d) => d.cause === 'animation' && d.drawable.id === 'd'));
  v.pause();
  await sleep(50);
  rig.sink.clear();
  await sleep(500);
  assert.equal(rig.sink.damage.length, 0, 'paused: no damage');
  assert.equal(rig.sink.hooks.size, 0, 'no frame hook where requestVideoFrameCallback exists');
});

test('without requestVideoFrameCallback a frame hook damages the video while its time moves, and removes itself when it pauses', async (t) => {
  const rig = createRig({ html: PAGE });
  const v = /** @type {HTMLVideoElement} */ (rig.layerEl.querySelector('#v'));
  Object.defineProperty(v, 'requestVideoFrameCallback', { value: undefined });
  t.cleanup(observeVideos(rig.env, rig.record));
  await v.play();
  assert.equal(rig.sink.hooks.size, 1, 'play starts the hook');
  rig.sink.clear();
  for (let i = 0; i < 10; i++) { runHooks(rig); await sleep(30); }
  assert.ok(rig.sink.damage.length >= 3, `damaged while playing: ${rig.sink.damage.length}`);
  v.pause();
  rig.sink.clear();
  assert.equal(runHooks(rig), false, 'paused: the hook removes itself');
  assert.equal(rig.sink.hooks.size, 0);
  assert.equal(rig.sink.damage.length, 0);
});
