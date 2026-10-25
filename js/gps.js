import { distanceMeters } from './utils.js';

export function validPoint(point) {
  return !!point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

// Pure evaluator: uncertainty interrupts the continuous, reliable 30-second window.
// This is advisory; a trusted authority must authorize penalties separately.
export function evaluateZone(previous, { location, center, radius, connected, timestamp }) {
  const base = { outsideSince:null, status:'unavailable', remaining:30 };
  if (!connected) return { ...base, status:'offline' };
  if (!validPoint(center) || !validPoint(location)) return base;
  const age = timestamp - location.measuredAt;
  if (!Number.isFinite(age) || age < -2000 || age > 10000) return { ...base, status:'stale' };
  if (!Number.isFinite(location.accuracy) || location.accuracy <= 0 || location.accuracy > 50) return { ...base, status:'uncertain' };
  const distance = distanceMeters(location, center);
  if (distance + location.accuracy <= radius) return { ...base, status:'inside' };
  if (distance - location.accuracy <= radius) return { ...base, status:'uncertain' };
  const outsideSince = previous?.outsideSince ?? timestamp;
  const remaining = Math.max(0, Math.ceil((30000 - (timestamp - outsideSince)) / 1000));
  return { outsideSince, remaining, status:remaining ? 'warning' : 'outside' };
}
