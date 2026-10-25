import { validPoint } from './gps.js';
import { mutateRoom, remoteAction } from './store.js';
import { DEFAULT_SETTINGS, SKILLS, eligibleSkills, SKILL_IDS } from './skills.js';
import { now, randomId, randomFrom, distanceMeters, clamp } from './utils.js';

export function createRoomData(hostId, hostName) {
  const timestamp = now();
  const player = {
    id:hostId, name:hostName, isHost:true, joinedAt:timestamp, role:'waiting', status:'waiting', active:true,
    coins:0, inventory:[], location:null, locationAt:0, effects:{}, rewardAt:timestamp, foundItems:0, tasksSolved:0
  };
  return {
    code:null, hostId, createdAt:timestamp, phase:'lobby', phaseEndsAt:null, matchEndsAt:null, startedAt:null,
    settings:JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), players:{[hostId]:player}, itemBoxes:{}, traps:{}, decoys:{}, effects:{},
    pendingCatch:null, announcement:null, eventLog:[], lastPhaseTransitionAt:timestamp
  };
}

export function addPlayerToRoom(room, uid, name) {
  if (!room) return { ok:false, reason:'Diese Lobby existiert nicht.' };
  if (['closed','finished'].includes(room.phase)) return { ok:false, reason:'Diese Runde ist beendet.' };
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 18 || !/^[\p{L}\p{N}_ -]+$/u.test(name)) return { ok:false, reason:'Ungültiger Codename.' };
  if (!uid) return { ok:false, reason:'Anmeldung fehlt.' };
  if (room.players?.[uid]) {
    const existing = room.players[uid];
    if (existing.status === 'left') {
      const previousStatus = existing.previousStatus;
      if (previousStatus === 'caught') { existing.active = false; existing.status = 'caught'; }
      else {
        existing.active = true;
        existing.status = previousStatus || (existing.role === 'hider' ? 'hiding' : existing.role === 'seeker' ? 'seeker' : existing.role);
      }
      delete existing.previousStatus;
    }
    return { ok:true, already:true };
  }
  if (room.phase !== 'lobby') return { ok:false, reason:'Diese Lobby läuft bereits.' };
  const players = Object.values(room.players || {}).filter((p) => p.active);
  if (players.length >= 20) return { ok:false, reason:'Die Lobby ist voll (max. 20 Spieler).' };
  if (players.some((p) => p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return { ok:false, reason:'Dieser Codename ist bereits vergeben.' };
  room.players ||= {};
  room.players[uid] = {
    id:uid, name, isHost:false, joinedAt:now(), role:'waiting', status:'waiting', active:true,
    coins:0, inventory:[], location:null, locationAt:0, effects:{}, rewardAt:now(), foundItems:0, tasksSolved:0
  };
  return { ok:true };
}

export function updateSettings(room, uid, patch) {
  if (room.hostId !== uid || room.phase !== 'lobby') return null;
  room.settings ||= JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const allowed = ['mode','hideDuration','gameDuration','radius','seekerCount','announcements'];
  const safePatch = Object.fromEntries(allowed.filter((key) => key in patch).map((key) => [key, patch[key]]));
  if (patch.center && validPoint(patch.center)) safePatch.center = {lat:patch.center.lat, lng:patch.center.lng};
  const skills = Object.fromEntries(SKILL_IDS.filter((id) => typeof patch.skills?.[id] === 'boolean').map((id) => [id,patch.skills[id]]));
  room.settings = { ...room.settings, ...safePatch, skills:{ ...room.settings.skills, ...skills } };
  if (!['classic','infected'].includes(room.settings.mode)) room.settings.mode = 'classic';
  room.settings.announcements = room.settings.announcements !== false;
  room.settings.hideDuration = clamp(Number(room.settings.hideDuration) || 180, 120, 300);
  room.settings.gameDuration = clamp(Number(room.settings.gameDuration) || 1200, 900, 1800);
  room.settings.radius = clamp(Number(room.settings.radius) || 500, 100, 2000);
  room.settings.seekerCount = clamp(Number(room.settings.seekerCount) || 1, 1, 10);
  return room;
}

export function startCountdown(room, uid, hostLocation) {
  if (room.hostId !== uid) return { ok:false, reason:'Nur der Host kann den Einsatz starten.' };
  const players = Object.values(room.players || {}).filter((player) => player.active);
  if (room.phase !== 'lobby') return { ok:false, reason:'Diese Runde wurde bereits gestartet.' };
  if (players.length < 2) return { ok:false, reason:'Mindestens 2 Spieler werden benötigt.' };
  const center = room.settings.center || hostLocation || null;
  if (center) room.settings.center = { lat:center.lat, lng:center.lng };
  const requestedSeekers = clamp(Number(room.settings.seekerCount) || 1, 1, 10);
  if (requestedSeekers >= players.length) {
    return { ok:false, reason:'Es muss mindestens einen Hider geben. Reduziere die Anzahl der Seeker oder füge Spieler hinzu.' };
  }
  // Randomize the complete player order so no join order or host advantage determines roles.
  const shuffledPlayers = players.slice();
  for (let i = shuffledPlayers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledPlayers[i], shuffledPlayers[j]] = [shuffledPlayers[j], shuffledPlayers[i]];
  }
  const seekerIds = new Set(shuffledPlayers.slice(0, requestedSeekers).map((player) => player.id));
  const hiderSkills = eligibleSkills(room.settings, 'hider');
  const seekerSkills = eligibleSkills(room.settings, 'seeker');
  for (const player of players) {
    player.role = seekerIds.has(player.id) ? 'seeker' : 'hider';
    player.status = player.role === 'seeker' ? 'seeker' : 'hiding';
    player.active = true;
    player.inventory = [];
    player.effects = {};
    player.rewardAt = now();
    player.coins = Number(player.coins) || 0;
    // Each player receives one random starting skill from the enabled pool for their role.
    const startingPool = player.role === 'seeker' ? seekerSkills : hiderSkills;
    if (startingPool.length) player.inventory.push(randomFrom(startingPool));
  }
  room.phase = 'countdown';
  room.startedAt = now();
  room.phaseEndsAt = now() + 10_000;
  room.matchEndsAt = null;
  room.pendingCatch = null;
  room.itemBoxes = {};
  room.traps = {};
  room.decoys = {};
  room.effects = {};
  room.announcement = { id:randomId('announcement'), type:'system', title:'MISSION INITIALIZED', message:'Rollen werden zugewiesen. 10 Sekunden bis zur Enthüllung.', createdAt:now() };
  room.lastPhaseTransitionAt = now();
  return { ok:true };
}

export async function advanceExpiredPhase(code, room) {
  const remote = remoteAction('advanceExpiredPhase', [code, room]);
  if (remote) return remote;
  if (!room?.phaseEndsAt || now() < room.phaseEndsAt) return false;
  return mutateRoom(code, (current) => {
    if (!current?.phaseEndsAt || now() < current.phaseEndsAt) return null;
    const timestamp = current.phaseEndsAt;
    if (current.phase === 'countdown') {
      current.phase = 'reveal';
      current.phaseEndsAt = timestamp + 4500;
      current.announcement = { id:randomId('announcement'), type:'system', title:'IDENTITIES LOCKED', message:'Deine Rolle wurde zugewiesen.', createdAt:timestamp };
    } else if (current.phase === 'reveal') {
      current.phase = 'hide';
      current.phaseEndsAt = timestamp + (Number(current.settings.hideDuration) || 180) * 1000;
      current.announcement = { id:randomId('announcement'), type:'system', title:'HIDE PHASE', message:'Hider: findet Deckung. Seeker: Position halten.', createdAt:timestamp };
    } else if (current.phase === 'hide') {
      current.phase = 'playing';
      current.matchEndsAt = timestamp + (Number(current.settings.gameDuration) || 1200) * 1000;
      current.phaseEndsAt = current.matchEndsAt;
      current.lastPhaseTransitionAt = timestamp;
      current.itemBoxes = {};
      for (const player of Object.values(current.players || {})) player.rewardAt = timestamp;
      current.announcement = { id:randomId('announcement'), type:'system', title:'SEEK PHASE LIVE', message:'Die Jagd ist freigegeben. Signal Caches wurden aktiviert.', createdAt:timestamp };
    } else if (current.phase === 'playing') {
      current.phase = 'finished';
      current.winner = 'hiders';
      current.phaseEndsAt = null;
      current.announcement = { id:randomId('announcement'), type:'system', title:'MISSION COMPLETE', message:'Der Countdown ist abgelaufen. Einsatz beendet.', createdAt:timestamp };
    } else return null;
    current.lastPhaseTransitionAt = timestamp;
    return current;
  }).then((result) => Boolean(result));
}

export async function maybePayTimeReward(code, uid) {
  const remote = remoteAction('maybePayTimeReward', [code, uid]);
  if (remote) return remote;
  return mutateRoom(code, (room) => {
    const player = room.players?.[uid];
    if (!player || room.phase !== 'playing' || player.role !== 'seeker' || !player.active) return null;
    const timestamp = now();
    if (timestamp - (player.rewardAt || timestamp) < 30_000) return null;
    player.coins = (Number(player.coins) || 0) + 3;
    player.rewardAt = timestamp;
    room.announcement = { id:randomId('announcement'), type:'private', targetId:uid, title:'TIME BONUS', message:'+3 Credits für aktive Jagd.', createdAt:timestamp };
    return room;
  });
}

export async function updatePlayerLocation(code, uid, location) {
  const remote = remoteAction('updatePlayerLocation', [code, uid, location]);
  if (remote) return remote;
  return mutateRoom(code, (room) => {
    const player = room.players?.[uid];
    if (!player || !player.active) return null;
    if (!validPoint(location) || !Number.isFinite(location.accuracy) || location.accuracy <= 0 || !Number.isFinite(location.measuredAt) || now() - location.measuredAt > 10000 || location.measuredAt > now() + 2000) return null;
    player.location = { lat:location.lat, lng:location.lng, accuracy:location.accuracy, measuredAt:location.measuredAt, ...(Number.isFinite(location.altitude) && location.altitude >= -500 && location.altitude <= 10000 ? {altitude:location.altitude} : {}) };
    player.locationAt = now();
    if (!room.settings.center && room.hostId === uid && location.accuracy <= 50) {
      room.settings.center = { lat:player.location.lat, lng:player.location.lng };
    }
    // Traps are resolved transactionally so a seeker's device cannot trigger the same trap twice.
    if (room.phase === 'playing' && player.role === 'seeker' && (player.effects?.frozenUntil || 0) < now()) {
      for (const trap of Object.values(room.traps || {})) {
        if (trap.triggeredBy || (trap.expiresAt || 0) <= now()) continue;
        if (distanceMeters(player.location, trap.location) <= (trap.radius || 25)) {
          trap.triggeredBy = uid;
          player.effects ||= {};
          player.effects.frozenUntil = now() + 15_000;
          room.announcement = { id:randomId('announcement'), type:'private', targetId:uid, title:'EMP TRAP TRIGGERED', message:'Dein Bildschirm ist 15 Sekunden blockiert.', createdAt:now() };
          break;
        }
      }
    }
    return room;
  });
}

export async function requestCatch(code, seekerId, targetId) {
  const remote = remoteAction('requestCatch', [code, seekerId, targetId]);
  if (remote) return remote;
  return mutateRoom(code, (room) => {
    const seeker = room.players?.[seekerId];
    const target = room.players?.[targetId];
    if (room.phase !== 'playing' || !seeker || seeker.role !== 'seeker' || !seeker.active) return null;
    if (!target || target.role !== 'hider' || !target.active) return null;
    const timestamp=now();
    if(!freshCatchLocation(seeker,timestamp) || !freshCatchLocation(target,timestamp) || distanceMeters(seeker.location,target.location)>5) return null;
    if(!applyCatch(room,seekerId,targetId,timestamp)) return null;
    return room;
  });
}

export async function respondToCatch(code, targetId, accepted, requestId=null) {
  const remote = remoteAction('respondToCatch', [code, targetId, accepted, requestId]);
  if (remote) return remote;
  return mutateRoom(code, (room) => {
    const request = room.pendingCatch;
    if (room.phase !== 'playing' || !request || request.targetId !== targetId || request.status !== 'pending' || (requestId && request.id !== requestId) || now() - request.createdAt > 20000 || request.createdAt > now()) return null;
    const target = room.players?.[targetId];
    const seeker = room.players?.[request.seekerId];
    if (!target || !seeker || !target.active || !seeker.active || target.role !== 'hider' || seeker.role !== 'seeker') return null;
    if (!accepted) {
      room.pendingCatch = null;
      room.announcement = { id:randomId('announcement'), type:'private', targetId:request.seekerId, title:'CATCH DECLINED', message:`${target.name} hat den Fang abgelehnt.`, createdAt:now() };
      return room;
    }
    const timestamp = now();
    target.effects ||= {};
    if (target.effects.shield === true) {
      target.effects.shield = false;
      room.pendingCatch = null;
      room.announcement = { id:randomId('announcement'), type:'private', targetId, title:'SHIELD ACTIVATED', message:'Dein Schild hat den Fangversuch abgewehrt.', createdAt:timestamp };
      room.announcementForSeeker = { id:randomId('announcement'), targetId:request.seekerId, title:'SHIELD BLOCKED', message:`${target.name} hat einen Schild eingesetzt.`, createdAt:timestamp };
      return room;
    }
    if (room.settings.mode === 'infected') {
      target.role = 'seeker';
      target.status = 'infected';
      target.active = true;
      const available = eligibleSkills(room.settings, 'seeker');
      target.inventory = available.length ? [randomFrom(available)] : [];
    } else {
      target.role = 'spectator';
      target.status = 'caught';
      target.active = false;
      target.inventory = [];
    }
    room.pendingCatch = null;
    const nowHiders = Object.values(room.players || {}).filter((player) => player.active && player.role === 'hider');
    const announcementText = room.settings.announcements ? (room.settings.mode === 'infected' ? `${target.name} wurde gefangen und ist nun infiziert!` : `${target.name} wurde gefangen!`) : null;
    room.announcement = announcementText ? { id:randomId('announcement'), type:'global', title:'PLAYER CAPTURED', message:announcementText, createdAt:timestamp, targetId:null } : { id:randomId('announcement'), type:'private', targetId:request.seekerId, title:'CATCH CONFIRMED', message:`${target.name} wurde als gefangen bestätigt.`, createdAt:timestamp };
    if (nowHiders.length === 0) {
      room.phase = 'finished';
      room.winner = 'seekers';
      room.phaseEndsAt = null;
      room.announcement = { id:randomId('announcement'), type:'global', title:'MISSION COMPLETE', message:room.settings.mode === 'infected' ? 'Alle Hider wurden infiziert.' : 'Alle Hider wurden gefangen.', createdAt:timestamp };
    }
    return room;
  });
}

function freshCatchLocation(player,timestamp) {
  return Boolean(player.location && timestamp-(player.locationAt||0)<=10000 && timestamp>=player.locationAt && Number(player.location.accuracy)<=25);
}

function applyCatch(room,seekerId,targetId,timestamp) {
  const target=room.players?.[targetId], seeker=room.players?.[seekerId];
  if(!target?.active || !seeker?.active || target.role!=='hider' || seeker.role!=='seeker') return false;
  room.pendingCatch=null;
  target.effects ||= {};
  if(target.effects.shield===true) {
    target.effects.shield=false;
    room.announcement={id:randomId('announcement'),type:'global',title:'SHIELD ACTIVATED',message:`${target.name} hat den Fang mit einem Schild abgewehrt.`,createdAt:timestamp};
    return true;
  }
  if(room.settings.mode==='infected') {
    target.role='seeker'; target.status='infected'; target.active=true;
    const available=eligibleSkills(room.settings,'seeker'); target.inventory=available.length?[randomFrom(available)]:[];
  } else {
    target.role='spectator'; target.status='caught'; target.active=false; target.inventory=[];
  }
  room.pendingCatch=null;
  room.announcement=room.settings.announcements===false
    ? {id:randomId('announcement'),type:'private',targetId:seekerId,title:'CATCH CONFIRMED',message:`${target.name} wurde gefangen.`,createdAt:timestamp}
    : {id:randomId('announcement'),type:'global',title:'PLAYER CAPTURED',message:room.settings.mode==='infected'?`${target.name} wurde gefangen und ist nun infiziert!`:`${target.name} wurde gefangen!`,createdAt:timestamp};
  if(!Object.values(room.players||{}).some(player=>player.active && player.role==='hider')) {
    room.phase='finished'; room.winner='seekers'; room.phaseEndsAt=null; room.photoMetadata={};
    room.announcement={id:randomId('announcement'),type:'global',title:'MISSION COMPLETE',message:room.settings.mode==='infected'?'Alle Hider wurden infiziert.':'Alle Hider wurden gefangen.',createdAt:timestamp};
  }
  return true;
}

export async function buySkill(code, uid, skillId) {
  const remote = remoteAction('buySkill', [code, uid, skillId]);
  if (remote) return remote;
  const skill = SKILLS[skillId];
  if (!skill) return { ok:false, reason:'Unbekannte Fähigkeit.' };
  const result = await mutateRoom(code, (room) => {
    const player = room.players?.[uid];
    if (!player || !player.active || player.role !== skill.side) return null;
    if (room.phase !== 'playing' && !(player.role === 'hider' && room.phase === 'hide')) return null;
    if (room.settings.skills?.[skillId] === false) return null;
    if ((Number(player.coins) || 0) < skill.price) return null;
    player.coins -= skill.price;
    player.inventory ||= [];
    player.inventory.push(skillId);
    room.announcement = { id:randomId('announcement'), type:'private', targetId:uid, title:'SKILL ACQUIRED', message:`${skill.short} zum Arsenal hinzugefügt.`, createdAt:now() };
    return room;
  });
  if (!result) return { ok:false, reason:'Nicht genug Credits oder Fähigkeit aktuell nicht verfügbar.' };
  return { ok:true };
}

export async function activateSkill(code, uid, skillId, params={}) {
  const remote = remoteAction('activateSkill', [code, uid, skillId, params]);
  if (remote) return remote;
  const skill = SKILLS[skillId];
  if (!skill) return { ok:false, reason:'Unbekannte Fähigkeit.' };
  const result = await mutateRoom(code, (room) => {
    const player = room.players?.[uid];
    if (!player || !player.active || player.role !== skill.side) return null;
    const allowedPhase = room.phase === 'playing' || (player.role === 'hider' && room.phase === 'hide');
    if (!allowedPhase || (player.effects?.frozenUntil || 0) > now()) return null;
    const inventoryIndex = (player.inventory || []).indexOf(skillId);
    if (inventoryIndex < 0) return null;
    if (inventoryIndex >= 0) player.inventory.splice(inventoryIndex, 1);
    const timestamp = now();
    player.effects ||= {};
    const expiry = (duration) => timestamp + duration * 1000;
    if (skillId === 'sonar') player.effects.sonarUntil = expiry(5);
    else if (skillId === 'tracker' || skillId === 'compass') {
      const hiders = Object.values(room.players || {}).filter((p) => p.active && p.role === 'hider' && p.location && (p.effects?.ghostUntil || 0) < timestamp);
      const from = player.location;
      const sorted = hiders.sort((a,b) => distanceMeters(from,a.location) - distanceMeters(from,b.location));
      const target = skillId === 'compass' ? sorted[sorted.length - 1] : sorted[0];
      if (target) player.effects.trackerTarget = target.id;
      player.effects.trackerUntil = expiry(skill.duration || 60);
      if (skillId === 'compass') player.effects.compassUntil = expiry(30);
    } else if (skillId === 'jammer') room.effects.jammerUntil = expiry(45);
    else if (skillId === 'sprint') {
      player.effects.sprintUntil = expiry(20);
      room.announcement = { id:randomId('announcement'), type:'global', title:'SPRINT ALARM', message:`${player.name} hat einen Sprint-Alarm aktiviert. Bewegungs-Cues sind live.`, createdAt:timestamp };
    }
    else if (skillId === 'sweeper') {
      const from = player.location;
      let removed = 0;
      for (const [id, trap] of Object.entries(room.traps || {})) {
        if (distanceMeters(from, trap.location) <= 150) { delete room.traps[id]; removed++; }
      }
      player.lastActionMessage = `${removed} Falle(n) entfernt.`;
      player.lastActionAt = timestamp;
    } else if (skillId === 'ghost') player.effects.ghostUntil = expiry(45);
    else if (skillId === 'decoy') {
      const location = params.location || (player.location ? { lat:player.location.lat + 0.0006, lng:player.location.lng + 0.0006 } : room.settings.center);
      if (!location) return null;
      const id = randomId('decoy');
      room.decoys ||= {};
      room.decoys[id] = { id, ownerId:uid, location:{lat:Number(location.lat),lng:Number(location.lng)}, createdAt:timestamp, expiresAt:expiry(30) };
    } else if (skillId === 'trap') {
      if (!player.location) return null;
      const id = randomId('trap');
      room.traps ||= {};
      room.traps[id] = { id, ownerId:uid, location:{lat:player.location.lat,lng:player.location.lng}, createdAt:timestamp, expiresAt:expiry(90), radius:25, triggeredBy:null };
    } else if (skillId === 'shield') player.effects.shield = true;
    else if (skillId === 'seekerradar') player.effects.seekerradarUntil = expiry(10);
    else if (skillId === 'silent') player.effects.silentUntil = expiry(120);
    room.announcement = { id:randomId('announcement'), type:'private', targetId:uid, title:'SKILL ACTIVATED', message:`${skill.short} eingesetzt.`, createdAt:timestamp };
    return room;
  });
  if (!result) return { ok:false, reason:'Fähigkeit kann gerade nicht eingesetzt werden. Prüfe Rolle, Phase, Inventar und GPS.' };
  return { ok:true };
}

export async function collectItemBox(code, uid, boxId) {
  const remote = remoteAction('collectItemBox', [code, uid, boxId]);
  if (remote) return remote;
  const result = await mutateRoom(code, (room) => {
    const player = room.players?.[uid];
    const box = room.itemBoxes?.[boxId];
    if (!player || !player.active || !box || box.collected || room.phase !== 'playing' || !player.location) return null;
    if (distanceMeters(player.location, box.location) > 15) return null;
    box.collected = true;
    box.collectedBy = uid;
    box.collectedAt = now();
    player.coins = (Number(player.coins) || 0) + 10;
    player.foundItems = (Number(player.foundItems) || 0) + 1;
    const pool = eligibleSkills(room.settings, player.role === 'seeker' ? 'seeker' : 'hider');
    let bonus = null;
    if (pool.length && Math.random() < 0.22) {
      bonus = randomFrom(pool);
      player.inventory ||= [];
      player.inventory.push(bonus);
    }
    // The Worker places caches only after checking public OSM foot-access data.
    delete room.itemBoxes[boxId];
    room.announcement = { id:randomId('announcement'), type:'private', targetId:uid, title:'SIGNAL CACHE SECURED', message:bonus ? `+10 Credits und ${SKILLS[bonus].short} gefunden!` : '+10 Credits eingesammelt.', createdAt:now() };
    return room;
  });
  if (!result) return { ok:false, reason:'Du bist noch nicht nah genug (15 m), der Cache ist weg oder GPS ist nicht aktiv.' };
  return { ok:true };
}

export async function completeTask(code, uid, reward, proof=null) {
  const remote = remoteAction('completeTask', [code, uid, reward, proof]);
  if (remote) return remote;
  const points = reward === 'shake' ? 15 : 25;
  const result = await mutateRoom(code, (room) => {
    const player = room.players?.[uid];
    if (!player || !player.active || !['hide','playing'].includes(room.phase)) return null;
    player.coins = (Number(player.coins) || 0) + points;
    player.tasksSolved = (Number(player.tasksSolved) || 0) + 1;
    const pool = eligibleSkills(room.settings, player.role === 'seeker' ? 'seeker' : 'hider');
    if (pool.length && Math.random() < .5) {
      const id = randomFrom(pool);
      player.inventory ||= [];
      player.inventory.push(id);
      player.lastActionMessage = `+${points} Credits · Bonus-Skill: ${SKILLS[id].short}`;
    } else player.lastActionMessage = `+${points} Credits`;
    player.lastActionAt = now();
    room.announcement = { id:randomId('announcement'), type:'private', targetId:uid, title:'FIELD TASK COMPLETE', message:player.lastActionMessage, createdAt:now() };
    return room;
  });
  return Boolean(result);
}

export async function leaveRoom(code, uid) {
  const remote = remoteAction('leaveRoom', [code, uid]);
  if (remote) return remote;
  return mutateRoom(code, (room) => {
    if (room.hostId === uid) {
      room.phase = 'closed';
      room.closedAt = now();
      return room;
    }
    if (room.players?.[uid]) {
      room.players[uid].previousStatus = room.players[uid].status;
      room.players[uid].active = false;
      room.players[uid].status = 'left';
      if (room.pendingCatch?.targetId === uid || room.pendingCatch?.seekerId === uid) room.pendingCatch = null;
    }
    return room;
  });
}

export function activePlayer(room, uid) { return room?.players?.[uid] || null; }
