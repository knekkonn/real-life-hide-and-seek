import test from 'node:test';
import assert from 'node:assert/strict';

class FakeParam {
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class FakeNode {
  constructor() { this.gain = new FakeParam(); this.frequency = new FakeParam(); }
  connect() {}
  start() {}
  stop() {}
}

class FakeAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 1; this.destination = new FakeNode(); this.oscillators = []; }
  createGain() { return new FakeNode(); }
  createOscillator() { const oscillator = new FakeNode(); this.oscillators.push(oscillator); return oscillator; }
}

let nextTimer = 1;
const intervals = new Map();
globalThis.window = {
  AudioContext: FakeAudioContext,
  setInterval(callback) { const id = nextTimer++; intervals.set(id, callback); return id; },
  clearInterval(id) { intervals.delete(id); }
};

const { isSoundEnabled, setSoundEnabled, Sound } = await import('../js/utils.js');

test('sound effects can be muted, and muting stops the repeating tension cue', () => {
  assert.equal(isSoundEnabled(), true);
  Sound.click();
  assert.equal(intervals.size, 0);

  Sound.startTension();
  assert.equal(intervals.size, 1);
  setSoundEnabled(false);
  assert.equal(isSoundEnabled(), false);
  assert.equal(intervals.size, 0);

  Sound.startTension();
  Sound.click();
  assert.equal(intervals.size, 0);
  setSoundEnabled(true);
  Sound.startTension();
  assert.equal(intervals.size, 1);
  Sound.stopTension();
  assert.equal(intervals.size, 0);
});
