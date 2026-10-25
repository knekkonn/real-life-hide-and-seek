import test from 'node:test';
import assert from 'node:assert/strict';

class FakeParam {
  constructor() { this.value = 0; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  exponentialRampToValueAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
}

class FakeAudioNode {
  constructor() { this.gain = new FakeParam(); this.frequency = new FakeParam(); this.disconnectCount = 0; }
  connect() {}
  disconnect() { this.disconnectCount++; }
  start() {}
  stop() {}
  addEventListener() {}
}

class FakeAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 1; this.destination = new FakeAudioNode(); this.oscillators = []; }
  createGain() { return new FakeAudioNode(); }
  createBiquadFilter() { return new FakeAudioNode(); }
  createOscillator() { const oscillator = new FakeAudioNode(); this.oscillators.push(oscillator); return oscillator; }
  async resume() { this.state = 'running'; }
}

const listeners = new Map();
let nextTimer = 1;
const intervals = new Map();
const preferences = new Map();
globalThis.document = {
  visibilityState: 'visible',
  addEventListener(type, callback) { listeners.set(type, callback); }
};
globalThis.window = {
  AudioContext: FakeAudioContext,
  setInterval(callback) { const id = nextTimer++; intervals.set(id, callback); return id; },
  clearInterval(id) { intervals.delete(id); },
  setTimeout(callback) { callback(); }
};
globalThis.localStorage = {
  getItem(key) { return preferences.get(key) ?? null; },
  setItem(key, value) { preferences.set(key, value); }
};

const { getMusicPreference, isMusicEnabled, isSoundEnabled, setMusicEnabled, setSoundEnabled, Sound } = await import('../js/utils.js');

test('background music is opt-in and can be muted independently from sound effects', async () => {
  assert.equal(isMusicEnabled(), false);
  assert.equal(getMusicPreference(), false);
  setSoundEnabled(false);

  assert.equal(await setMusicEnabled(true), true);
  assert.equal(isMusicEnabled(), true);
  assert.equal(isSoundEnabled(), false);
  assert.equal(getMusicPreference(), true);

  assert.equal(intervals.size, 1);
  assert.equal(await setMusicEnabled(false), false);
  assert.equal(isMusicEnabled(), false);
  assert.equal(getMusicPreference(), false);
  assert.equal(intervals.size, 0);

  setSoundEnabled(true);
  Sound.startTension();
  assert.equal(intervals.size, 1);
  setSoundEnabled(false);
  assert.equal(intervals.size, 0);
});

test('hiding the page stops its ambience and returning can resume it', async () => {
  assert.equal(await setMusicEnabled(true), true);
  const onVisibilityChange = listeners.get('visibilitychange');
  document.visibilityState = 'hidden';
  onVisibilityChange();
  assert.equal(intervals.size, 0);

  document.visibilityState = 'visible';
  onVisibilityChange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(intervals.size, 1);
  await setMusicEnabled(false);
});
