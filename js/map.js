import { SKILLS } from './skills.js';
import { escapeHTML, now, distanceMeters, bearingDegrees, formatTime } from './utils.js';

let map = null;
let radiusCircle = null;
let centerMarker = null;
let mapMarkers = new Map();
let lastDrawKey = '';
let userMarker = null;
let userCircle = null;
let boundsWasFit = false;
let compassOverlay = null;
let roundTrackMap = null;
let roundTrackLayers = [];
let roundTrackFrame = null;
let roundTrackSignature = '';
const TRACK_COLORS = ['#49d7ff','#ff718d','#c9ff54','#b88cff','#ffbe5c','#62e6bc','#ff78d4','#89a9ff','#e8ec73','#ff9468'];
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function addFreeMapTiles(target) {
  L.tileLayer(OSM_TILES, {
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap-Mitwirkende</a>',
    maxZoom:19, className:'osm-dark-tiles'
  }).addTo(target);
}

function markerIcon(kind) {
  return L.divIcon({ className:'custom-map-marker', html:`<div class="map-marker-core ${kind}"></div>`, iconSize:[20,20], iconAnchor:[10,10] });
}

export function initMap() {
  const mapElement = document.getElementById('map');
  if (!mapElement || !window.L) return null;
  if (map) return map;
  map = L.map(mapElement, { zoomControl:true, preferCanvas:true, zoomSnap:.5 }).setView([52.52,13.405], 12);
  addFreeMapTiles(map);
  map.on('load', () => {});
  compassOverlay = document.createElement('div');
  compassOverlay.className = 'compass-overlay';
  compassOverlay.innerHTML = '<span class="compass-face"><span id="compassArrow">➤</span></span><span id="compassText">TARGET BEARING</span>';
  compassOverlay.style.display = 'none';
  map.getContainer().appendChild(compassOverlay);
  return map;
}

export function invalidateMapSize() {
  if (map) setTimeout(() => map.invalidateSize({ animate:false }), 80);
}

export function centerMap(location) {
  if (map && location && Number.isFinite(location.lat) && Number.isFinite(location.lng)) map.setView([location.lat, location.lng], Math.max(map.getZoom(), 15), { animate:true });
}

function putMarker(id, point, kind, label, detail='') {
  if (!map || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
  const existing = mapMarkers.get(id);
  label = escapeHTML(label || '');
  const popupHtml = label ? `<strong>${label}</strong>${detail ? `<br>${escapeHTML(detail)}` : ''}` : '';
  if (existing) {
    existing.setLatLng([point.lat, point.lng]);
    if (existing._hideSeekKind !== kind) {
      existing.setIcon(markerIcon(kind));
      existing._hideSeekKind = kind;
    }
    if (label && existing._hideSeekPopup !== popupHtml) {
      existing.bindPopup(popupHtml);
      existing._hideSeekPopup = popupHtml;
    }
  } else {
    const marker = L.marker([point.lat, point.lng], { icon:markerIcon(kind), keyboard:false }).addTo(map);
    marker._hideSeekKind = kind;
    marker._hideSeekPopup = popupHtml;
    if (label) marker.bindPopup(popupHtml);
    mapMarkers.set(id, marker);
  }
}

export function updateMap(room, selfId, ownLocation, role, gpsSyncStatus='idle') {
  if (!map || !room) return;
  const center = room.settings?.center || ownLocation || null;
  const radius = Number(room.settings?.radius) || 500;
  if (center) {
    if (!radiusCircle) radiusCircle = L.circle([center.lat,center.lng], { radius, color:'#b9ff52', weight:1.5, opacity:.66, fillColor:'#b9ff52', fillOpacity:.035, dashArray:'7 7' }).addTo(map);
    else radiusCircle.setLatLng([center.lat,center.lng]).setRadius(radius);
    if (!centerMarker) centerMarker = L.circleMarker([center.lat,center.lng], { radius:3, color:'#b9ff52', fillColor:'#b9ff52', fillOpacity:1, weight:1 }).addTo(map);
    else centerMarker.setLatLng([center.lat,center.lng]);
  } else {
    if (radiusCircle) map.removeLayer(radiusCircle);
    if (centerMarker) map.removeLayer(centerMarker);
    radiusCircle = null; centerMarker = null;
  }

  const allowed = new Set();
  const players = Object.values(room.players || {});
  const self = room.players?.[selfId];
  if (['visit','scan'].includes(self?.activeTask?.kind) && !self.activeTask.failed && !self.activeTask.completed && self.activeTask.targetLocation && ['hide','playing'].includes(room.phase)) {
    const id = `task-target:${selfId}`;
    allowed.add(id);
    putMarker(id, self.activeTask.targetLocation, 'cache', 'Geheimer Feldzielpunkt', 'Nur für dich sichtbar · Nähe erforderlich');
  }
  if (ownLocation) {
    allowed.add(`player:${selfId}`);
    const ownHeight=Number.isFinite(ownLocation.altitude)?` · Höhe ${Math.round(ownLocation.altitude)} m`:'';
    putMarker(`player:${selfId}`, ownLocation, 'self', 'Deine Position', `GPS aktiv${ownHeight}`);
    if (!userCircle) userCircle = L.circle([ownLocation.lat,ownLocation.lng], { radius:8, color:'#b9ff52', weight:1, fillColor:'#b9ff52', fillOpacity:.08 }).addTo(map);
    else userCircle.setLatLng([ownLocation.lat,ownLocation.lng]);
  }

  const isActive = ['playing','hide','reveal','countdown'].includes(room.phase);
  const currentRole = self?.role || role;
  const myEffects = self?.effects || {};
  const sonarActive = (myEffects.sonarUntil || 0) > now();
  const trackerTarget = (myEffects.trackerUntil || 0) > now() ? myEffects.trackerTarget : null;
  const compassActive = (myEffects.compassUntil || 0) > now() && trackerTarget;
  const jammerActive = (room.effects?.jammerUntil || 0) > now();
  const seekerRadarActive = (myEffects.seekerradarUntil || 0) > now() && !jammerActive;
  const publicDecoys = Object.values(room.decoys || {}).filter((decoy) => (decoy.expiresAt || 0) > now());
  const traps = Object.values(room.traps || {}).filter((trap) => (trap.expiresAt || 0) > now());
  const itemBoxes = Object.values(room.itemBoxes || {}).filter((box) => !box.collected);

  for (const player of players) {
    if (!player.location || !player.active || now() - player.locationAt > 10000) continue;
    if (player.id === selfId) continue;
    let show = false;
    let kind = player.role === 'seeker' ? 'seeker' : 'hider';
    let label = player.name;
    if (currentRole === 'seeker') {
      show = player.role === 'hider' && isActive && ((sonarActive && (player.effects?.ghostUntil || 0) < now()) || trackerTarget === player.id);
    } else if (currentRole === 'hider') {
      show = player.role === 'seeker' && seekerRadarActive;
    }
    if (player.role === 'spectator') show = false;
    if (show) {
      const id = `player:${player.id}`;
      allowed.add(id);
      const detailParts=[trackerTarget === player.id ? `TRACK LOCK · ${formatTime((myEffects.trackerUntil-now())/1000)}` : (kind === 'seeker' ? 'Seeker-Signal' : 'Sonar-Kontakt')];
      if(Number.isFinite(player.location.floor)) detailParts.push(`Etage ${player.location.floor>0?'+':''}${player.location.floor}`);
      if(Number.isFinite(ownLocation?.altitude) && Number.isFinite(player.location.altitude)) {
        const delta=Math.round(player.location.altitude-ownLocation.altitude);
        if(Math.abs(delta)>=3) detailParts.push(`${delta>0?'↑':'↓'} ${Math.abs(delta)} m Höhe`);
      }
      const detail=detailParts.join(' · ');
      putMarker(id, player.location, kind, label, detail);
    }
  }
  if (compassOverlay) {
    const target = compassActive ? room.players?.[trackerTarget] : null;
    if (ownLocation && target?.location) {
      const bearing = Math.round(bearingDegrees(ownLocation, target.location));
      compassOverlay.style.display = 'flex';
      const arrow = compassOverlay.querySelector('#compassArrow');
      const text = compassOverlay.querySelector('#compassText');
      if (arrow) arrow.style.transform = `rotate(${bearing}deg)`;
      if (text) text.textContent = `BEARING · ${bearing}°`;
    } else compassOverlay.style.display = 'none';
  }
  for (const decoy of publicDecoys) {
    if (currentRole !== 'seeker') continue;
    const id = `decoy:${decoy.id}`;
    allowed.add(id);
    putMarker(id, decoy.location, 'decoy', 'Signal-Anomalie', 'Möglicher Täusch-Ping');
  }
  for (const trap of traps) {
    const id = `trap:${trap.id}`;
    allowed.add(id);
    putMarker(id, trap.location, 'cache', 'Digitale Falle', `${Math.max(0,Math.ceil((trap.expiresAt-now())/1000))} s verbleibend`);
  }
  for (const box of itemBoxes) {
    const id = `box:${box.id}`;
    allowed.add(id);
    const level=Number.isFinite(box.level)?`Etage ${box.level>0?'+':''}${box.level}`:Number.isFinite(box.layer)&&box.layer!==0?`Ebene ${box.layer>0?'+':''}${box.layer}`:'';
    putMarker(id, box.location, 'cache', 'Signal Cache', `Itembox · Nähe erforderlich${level?` · ${level}`:''}`);
  }
  for (const [id, marker] of mapMarkers.entries()) {
    if (!allowed.has(id)) { map.removeLayer(marker); mapMarkers.delete(id); }
  }
  const mapCaption = document.getElementById('mapCaption');
  if (mapCaption) mapCaption.textContent = role === 'hider' && jammerActive ? `RADAR-JAMMER AKTIV · ${Math.ceil((room.effects.jammerUntil-now())/1000)} S` : ownLocation ? gpsSyncStatus==='synced' ? 'GPS-Signal verbunden · servergesichert und privat' : gpsSyncStatus==='syncing' ? 'GPS-Signal verbunden · Synchronisierung läuft' : gpsSyncStatus==='error'||gpsSyncStatus==='offline' ? 'GPS aktuell nur auf diesem Gerät · offline' : 'GPS-Signal verbunden · Synchronisierung ausstehend' : 'GPS wartet auf Freigabe';
  const chip = document.getElementById('mapRadiusChip');
  if (chip) chip.textContent = `RADIUS ${radius} M`;
  if (!boundsWasFit && (ownLocation || room.settings?.center)) {
    const viewCenter = ownLocation || room.settings.center;
    map.setView([viewCenter.lat, viewCenter.lng], ownLocation ? 15 : 14);
    boundsWasFit = true;
  }
}

export function resetMap() {
  if (!map) return;
  for (const marker of mapMarkers.values()) map.removeLayer(marker);
  mapMarkers.clear();
  if (radiusCircle) map.removeLayer(radiusCircle);
  if (centerMarker) map.removeLayer(centerMarker);
  if (userCircle) map.removeLayer(userCircle);
  radiusCircle = null; centerMarker = null; userCircle = null; boundsWasFit = false;
  if (compassOverlay) compassOverlay.style.display = 'none';
  map.setView([52.52,13.405], 12, { animate:false });
}

export function getMap() { return map; }

function trackColor(id) {
  let hash=0;
  for(const character of String(id)) hash=(hash*31+character.charCodeAt(0))|0;
  return TRACK_COLORS[Math.abs(hash)%TRACK_COLORS.length];
}

export function drawRoundTracks(roundId, tracks, players) {
  const mapElement=document.getElementById('roundTrackMap');
  const empty=document.getElementById('roundTrackEmpty');
  const legend=document.getElementById('roundTrackLegend');
  if(!mapElement || !empty || !legend || !window.L) return;
  const entries=Object.entries(tracks||{}).map(([id,track])=>({id,track,points:(track.points||[]).filter(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)).map(([lat,lng])=>[lat,lng])})).filter(item=>item.points.length>1);
  const signature=String(roundId)+JSON.stringify(entries.map(({id,track,points})=>[id,points.length,points[0],points.at(-1),track.distanceMeters]));
  if(signature===roundTrackSignature) { if(roundTrackMap) requestAnimationFrame(()=>roundTrackMap.invalidateSize()); return; }
  roundTrackSignature=signature;
  if(roundTrackFrame!==null) cancelAnimationFrame(roundTrackFrame);
  for(const layer of roundTrackLayers) roundTrackMap?.removeLayer(layer);
  roundTrackLayers=[];
  if(!entries.length) {
    mapElement.classList.add('hidden'); empty.classList.remove('hidden'); legend.innerHTML='';
    return;
  }
  empty.classList.add('hidden'); mapElement.classList.remove('hidden');
  if(!roundTrackMap) {
    roundTrackMap=L.map(mapElement,{zoomControl:true,preferCanvas:true,scrollWheelZoom:false}).setView([52.52,13.405],12);
    addFreeMapTiles(roundTrackMap);
  }
  const bounds=L.latLngBounds([]);
  legend.innerHTML=entries.map(({id,track,points})=>{
    const color=trackColor(id), name=players?.[id]?.name||'Operative', km=((Number(track.distanceMeters)||0)/1000).toFixed(2);
    points.forEach(point=>bounds.extend(point));
    const line=L.polyline([],{color,weight:4,opacity:.9,lineCap:'round',lineJoin:'round'}).addTo(roundTrackMap);
    const start=L.circleMarker(points[0],{radius:5,color:'#08111a',weight:2,fillColor:color,fillOpacity:1}).addTo(roundTrackMap).bindTooltip(`${escapeHTML(name)} · Start`);
    const finish=L.circleMarker(points.at(-1),{radius:6,color:'#ffffff',weight:2,fillColor:color,fillOpacity:1}).addTo(roundTrackMap).bindTooltip(`${escapeHTML(name)} · Ziel`);
    roundTrackLayers.push(line,start,finish);
    return `<span class="round-track-key"><i style="--track-color:${color}"></i><strong>${escapeHTML(name)}</strong><small>${km} km</small></span>`;
  }).join('');
  roundTrackMap.fitBounds(bounds.pad(.14),{maxZoom:16,animate:false});
  requestAnimationFrame(()=>roundTrackMap.invalidateSize());
  if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    for(const {id,points} of entries) roundTrackLayers.find(layer=>layer instanceof L.Polyline && layer.options.color===trackColor(id))?.setLatLngs(points);
    return;
  }
  const maxLength=Math.max(...entries.map(({points})=>points.length));
  let step=1;
  const animate=()=>{
    const amount=Math.max(2,Math.ceil((step/maxLength)*maxLength));
    for(const {id,points} of entries) {
      const line=roundTrackLayers.find(layer=>layer instanceof L.Polyline && layer.options.color===trackColor(id));
      if(line) line.setLatLngs(points.slice(0,Math.min(points.length,amount)));
    }
    step+=Math.max(1,Math.ceil(maxLength/90));
    if(step<=maxLength) roundTrackFrame=requestAnimationFrame(animate);
    else roundTrackFrame=null;
  };
  roundTrackFrame=requestAnimationFrame(animate);
}

export function clearRoundTracks() {
  if(roundTrackFrame!==null) cancelAnimationFrame(roundTrackFrame);
  roundTrackFrame=null; roundTrackSignature='';
  for(const layer of roundTrackLayers) roundTrackMap?.removeLayer(layer);
  roundTrackLayers=[];
  document.getElementById('roundTrackMap')?.classList.add('hidden');
  document.getElementById('roundTrackEmpty')?.classList.remove('hidden');
  const legend=document.getElementById('roundTrackLegend'); if(legend) legend.innerHTML='';
}

let lobbyMap = null;
let lobbyCircle = null;
let lobbyMarker = null;
let lobbySelect = null;
export function updateLobbyMap(room, host, onCenter) {
  if (!window.L || !document.getElementById('lobbyMap')) return;
  lobbySelect = host ? onCenter : null;
  if (!lobbyMap) {
    // World view is navigation only, never a player's position or actual zone.
    lobbyMap = L.map('lobbyMap').setView([20,0], 2);
    addFreeMapTiles(lobbyMap);
    lobbyMap.on('click', (event) => lobbySelect?.({lat:event.latlng.lat,lng:event.latlng.lng}));
  }
  const center = room.settings?.center;
  document.getElementById('lobbyZoneInfo').textContent = center ? `Radius ${room.settings.radius} m · ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}${host ? ' · Tippen oder Marker ziehen' : ''}` : 'Noch kein Mittelpunkt. Host: Karte wählen oder GPS freigeben.';
  if (center) {
    if (!lobbyCircle) {
      lobbyCircle = L.circle([center.lat,center.lng], {radius:room.settings.radius,color:'#b9ff52'}).addTo(lobbyMap);
      lobbyMarker = L.marker([center.lat,center.lng], {draggable:host}).addTo(lobbyMap);
      lobbyMarker.on('dragend', () => { const point = lobbyMarker.getLatLng(); lobbySelect?.({lat:point.lat,lng:point.lng}); });
      lobbyMap.fitBounds(lobbyCircle.getBounds());
    } else {
      lobbyCircle.setLatLng([center.lat,center.lng]).setRadius(room.settings.radius);
      lobbyMarker.setLatLng([center.lat,center.lng]);
    }
    if (host) lobbyMarker.dragging.enable(); else lobbyMarker.dragging.disable();
  }
  setTimeout(() => lobbyMap?.invalidateSize(), 0);
}
export function resetLobbyMap() {
  lobbyMap?.remove(); lobbyMap = null; lobbyCircle = null; lobbyMarker = null; lobbySelect = null;
}
