export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
let serverTimeOffsetMs = 0;
export function setServerTimeOffset(offsetMs) { serverTimeOffsetMs = Number.isFinite(Number(offsetMs)) ? Number(offsetMs) : 0; }
export const now = () => Date.now() + serverTimeOffsetMs;
export const formatTime = (seconds) => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = String(Math.floor(value / 60)).padStart(2, '0');
  const secs = String(value % 60).padStart(2, '0');
  return `${minutes}:${secs}`;
};
export const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
export const randomCode = () => String(Math.floor(1000 + Math.random() * 9000));
export const randomId = (prefix='id') => `${prefix}_${Math.random().toString(36).slice(2,9)}_${Date.now().toString(36)}`;
export const randomFrom = (items) => items[Math.floor(Math.random() * items.length)];

export function distanceMeters(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lng) || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
  return 6371000 * (2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h)));
}

export function destinationPoint(origin, distance, bearing) {
  const angular = distance / 6371000;
  const bearingRad = bearing * Math.PI / 180;
  const lat1 = origin.lat * Math.PI / 180;
  const lon1 = origin.lng * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearingRad));
  const lon2 = lon1 + Math.atan2(Math.sin(bearingRad) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * 180 / Math.PI, lng: ((lon2 * 180 / Math.PI + 540) % 360) - 180 };
}

export function bearingDegrees(a, b) {
  if (!a || !b) return 0;
  const rad = Math.PI / 180;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const dLng = (b.lng - a.lng) * rad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function randomPointInRadius(center, radiusMeters) {
  const angle = Math.random() * 360;
  const distance = Math.sqrt(Math.random()) * radiusMeters * 0.82;
  return destinationPoint(center, distance, angle);
}

let soundEnabled = true;
let audioContext = null;
let tensionTimer = null;
let tensionStep = 0;
let musicEnabled = false;
let musicTimer = null;
let musicMaster = null;
let musicStep = 0;

const AMBIENT_CHORDS = [
  [146.83, 220, 293.66, 349.23],
  [174.61, 220, 261.63, 349.23],
  [130.81, 196, 261.63, 329.63],
  [146.83, 196, 246.94, 293.66]
];

function getAudioContext() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!audioContext) audioContext = new AudioContextCtor();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

export function setSoundEnabled(enabled) {
  soundEnabled = Boolean(enabled);
  if (!soundEnabled) clearTension();
}
export function isSoundEnabled() { return soundEnabled; }

function clearTension() {
  if (tensionTimer) window.clearInterval(tensionTimer);
  tensionTimer = null;
}

function playAmbientChord(ctx, master, chord) {
  const start = ctx.currentTime + 0.03;
  chord.forEach((frequency, index) => {
    const oscillator = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const envelope = ctx.createGain();
    oscillator.type = index === 0 ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(index === 0 ? 520 : 1050, start);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.linearRampToValueAtTime(index === 0 ? 0.035 : 0.022, start + 2.8);
    envelope.gain.setValueAtTime(index === 0 ? 0.035 : 0.022, start + 6.6);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + 9.2);
    oscillator.connect(filter);
    filter.connect(envelope);
    envelope.connect(master);
    oscillator.start(start);
    oscillator.stop(start + 9.3);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      filter.disconnect();
      envelope.disconnect();
    }, { once: true });
  });
}

async function startAmbientMusic() {
  if (!musicEnabled || document.visibilityState === 'hidden') return false;
  const ctx = getAudioContext();
  if (!ctx) return false;
  try { await ctx.resume(); } catch { return false; }
  if (!musicEnabled || document.visibilityState === 'hidden' || ctx.state !== 'running') return false;
  if (musicTimer && musicMaster) return true;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, ctx.currentTime);
  master.gain.linearRampToValueAtTime(0.32, ctx.currentTime + 2.5);
  master.connect(ctx.destination);
  musicMaster = master;
  musicStep = 0;
  const play = () => {
    if (!musicEnabled || musicMaster !== master || document.visibilityState === 'hidden') return;
    playAmbientChord(ctx, master, AMBIENT_CHORDS[musicStep % AMBIENT_CHORDS.length]);
    musicStep++;
  };
  play();
  musicTimer = window.setInterval(play, 8000);
  return true;
}

function stopAmbientMusic() {
  if (musicTimer) window.clearInterval(musicTimer);
  musicTimer = null;
  const master = musicMaster;
  musicMaster = null;
  if (!master || !audioContext) return;
  const ctx = audioContext;
  const time = ctx.currentTime;
  master.gain.cancelScheduledValues(time);
  master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), time);
  master.gain.exponentialRampToValueAtTime(0.0001, time + 0.7);
  window.setTimeout(() => { try { master.disconnect(); } catch {} }, 800);
}

export async function setMusicEnabled(enabled) {
  musicEnabled = Boolean(enabled);
  if (musicEnabled && !await startAmbientMusic()) musicEnabled = false;
  try { localStorage.setItem('hide-seek-ambient-music', musicEnabled ? 'on' : 'off'); } catch { /* local preferences may be unavailable */ }
  if (!musicEnabled) stopAmbientMusic();
  return musicEnabled;
}

export function getMusicPreference() {
  try { return localStorage.getItem('hide-seek-ambient-music') === 'on'; }
  catch { return false; }
}
export function isMusicEnabled() { return musicEnabled; }

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopAmbientMusic();
    else if (musicEnabled) void startAmbientMusic();
  });
  document.addEventListener('pointerdown', () => {
    if (musicEnabled && !musicMaster) void startAmbientMusic();
  }, { passive: true });
}

function tone(frequency, duration=.12, type='sine', volume=.05, delay=0) {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  const start = ctx.currentTime + delay;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + .015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + .02);
}

export const Sound = {
  click() { tone(587.33, .055, 'sine', .014); },
  countdown() { tone(523.25, .12, 'sine', .025); },
  go() { tone(392, .16, 'triangle', .032); tone(523.25, .2, 'sine', .03, .1); tone(659.25, .28, 'sine', .032, .22); },
  item() { tone(523.25, .1, 'sine', .026); tone(659.25, .13, 'sine', .03, .08); tone(783.99, .2, 'sine', .028, .18); },
  alert() { tone(392, .18, 'triangle', .025); tone(493.88, .2, 'triangle', .028, .19); tone(587.33, .26, 'sine', .025, .4); },
  error() { tone(220, .17, 'sine', .02); tone(164.81, .2, 'sine', .018, .11); },
  success() { tone(523.25, .12, 'sine', .028); tone(659.25, .15, 'sine', .026, .08); tone(783.99, .2, 'sine', .026, .16); },
  startTension() {
    if (!soundEnabled || tensionTimer) return;
    tensionStep = 0;
    const play = () => {
      const notes = [110, 146.8, 123.5, 164.8];
      tone(notes[tensionStep % notes.length], .36, 'triangle', .014);
      if (tensionStep % 2 === 0) tone(55, .4, 'sine', .013, .04);
      tensionStep++;
    };
    play();
    tensionTimer = window.setInterval(play, 850);
  },
  stopTension() { clearTension(); }
};

export function haptic(pattern=20) {
  try { if ('vibrate' in navigator) navigator.vibrate(pattern); } catch { /* no haptics available */ }
}
