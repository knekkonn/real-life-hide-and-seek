import { distanceMeters } from './utils.js';

export function validPoint(point) {
  return !!point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

// Persisted once when the search starts. Time trades may end the match earlier,
// but never speed up the boundary or make it jump over players.
export function createZonePlan(settings, startedAt) {
  const initialRadius=Math.max(50,Math.min(2000,Number(settings?.radius)||500));
  const duration=Math.max(300,Math.min(1800,Number(settings?.gameDuration)||1200))*1000;
  const startsAt=startedAt+duration*.25,endsAt=startedAt+duration*.85;
  const requested=Math.max(25,initialRadius*Math.max(25,Math.min(75,Number(settings?.finalRadiusPercent)||35))/100);
  const finalRadius=Math.max(requested,initialRadius-(endsAt-startsAt)/1000);
  return {initialRadius,finalRadius,startsAt,endsAt};
}

export function getPlayZone(room,timestamp=Date.now()) {
  const initialRadius=Math.max(50,Math.min(2000,Number(room?.settings?.radius)||500));
  if(room?.settings?.zoneEnabled===false) return {radius:initialRadius,initialRadius,finalRadius:initialRadius,nextRadius:initialRadius,shrinking:false,enabled:false,status:'disabled',secondsUntilChange:0};
  const plan=room?.zonePlan;
  if(!plan || !['playing','finished'].includes(room.phase) || room.settings?.shrinkingZone===false) return {radius:initialRadius,initialRadius,finalRadius:initialRadius,nextRadius:initialRadius,shrinking:false,status:'fixed',secondsUntilChange:0};
  if(![plan.initialRadius,plan.finalRadius,plan.startsAt,plan.endsAt].every(Number.isFinite)||plan.endsAt<=plan.startsAt) return {radius:initialRadius,initialRadius,finalRadius:initialRadius,nextRadius:initialRadius,shrinking:false,status:'fixed',secondsUntilChange:0};
  const at=Math.min(timestamp,Number(room.matchEndsAt)||timestamp);
  const radiusAt=time=>plan.initialRadius-(plan.initialRadius-plan.finalRadius)*Math.max(0,Math.min(1,(time-plan.startsAt)/(plan.endsAt-plan.startsAt)));
  const radius=radiusAt(at),nextAt=Math.min(at+60000,Number(room.matchEndsAt)||Infinity);
  const status=at<plan.startsAt?'waiting':at<plan.endsAt?'closing':'final';
  return {radius,initialRadius:plan.initialRadius,finalRadius:plan.finalRadius,nextRadius:radiusAt(nextAt),shrinking:true,status,
    secondsUntilChange:Math.max(0,Math.ceil(((status==='waiting'?plan.startsAt:plan.endsAt)-at)/1000))};
}

export function playSettings(room,timestamp=Date.now()) {
  const zone=getPlayZone(room,timestamp);
  return {...room.settings,radius:zone.radius,zoneRadiusLimit:zone.finalRadius};
}

// Use callback receipt time as the sample time. Some browsers can expose a
// stale or non-wall-clock GeolocationPosition.timestamp; cached fixes are
// already bounded by the geolocation request's maximumAge option.
export function makeLocationSample(position, measuredAt=Date.now()) {
  const coords=position?.coords;
  if (!coords || !validPoint({lat:coords.latitude,lng:coords.longitude}) || !Number.isFinite(coords.accuracy) || coords.accuracy<=0 || !Number.isFinite(measuredAt)) throw new Error('INVALID_GPS_SAMPLE');
  return {lat:coords.latitude,lng:coords.longitude,accuracy:coords.accuracy,measuredAt,...(Number.isFinite(coords.altitude) && Number.isFinite(coords.altitudeAccuracy) && coords.altitudeAccuracy<=20 ? {altitude:coords.altitude} : {})};
}

// Pure evaluator: uncertainty interrupts the continuous, reliable 30-second window.
// This is advisory; a trusted authority must authorize penalties separately.
export function evaluateZone(previous, { location, center, radius, connected, timestamp, enabled=true }) {
  const base = { outsideSince:null, status:'unavailable', remaining:30 };
  if(enabled===false) return {...base,status:'inside'};
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
