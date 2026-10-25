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

function getAudioContext() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!audioContext) audioContext = new AudioContextCtor();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

export function setSoundEnabled(enabled) {
  soundEnabled = Boolean(enabled);
  if (!soundEnabled) stopTension();
}
export function isSoundEnabled() { return soundEnabled; }

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
  click() { tone(420, .045, 'triangle', .025); },
  countdown() { tone(660, .11, 'sine', .04); },
  go() { tone(540, .13, 'triangle', .06); tone(850, .22, 'sine', .055, .12); },
  item() { tone(690, .10, 'triangle', .055); tone(980, .18, 'sine', .045, .1); },
  alert() { tone(520, .16, 'sawtooth', .035); tone(710, .19, 'sawtooth', .035, .18); tone(520, .14, 'sawtooth', .03, .38); },
  error() { tone(190, .18, 'square', .025); },
  success() { tone(520, .08, 'sine', .04); tone(780, .13, 'sine', .04, .08); },
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
  stopTension() {
    if (tensionTimer) window.clearInterval(tensionTimer);
    tensionTimer = null;
  }
};

export function haptic(pattern=20) {
  try { if ('vibrate' in navigator) navigator.vibrate(pattern); } catch { /* no haptics available */ }
}
