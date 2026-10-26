import { validPoint, createZonePlan, getPlayZone, playSettings } from './gps.js';
import { mutateRoom, remoteAction } from './store.js';
import { DEFAULT_SETTINGS, SKILLS, eligibleSkills, SKILL_IDS, skillTuning, tacticalTuning, TASK_RULES } from './skills.js';
import { now, randomId, randomFrom, distanceMeters, clamp } from './utils.js';

export function createRoomData(hostId, hostName) {
  const timestamp = now();
  const player = {
    id:hostId, name:hostName, isHost:true, joinedAt:timestamp, role:'waiting', status:'waiting', active:true,
    coins:0, score:0, hidersFound:0, skillsUsed:0, longestStaySeconds:0, hiddenSeconds:0, stationarySince:0, inventory:[], location:null, locationAt:0, effects:{}, rewardAt:timestamp, foundItems:0, tasksSolved:0
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
    coins:0, score:0, hidersFound:0, skillsUsed:0, longestStaySeconds:0, hiddenSeconds:0, stationarySince:0, inventory:[], location:null, locationAt:0, effects:{}, rewardAt:now(), foundItems:0, tasksSolved:0
  };
  return { ok:true };
}

function secureShuffle(values) {
  const shuffled=values.slice(),cryptoApi=globalThis.crypto;
  for(let i=shuffled.length-1;i>0;i--) {
    let index;
    if(typeof cryptoApi?.getRandomValues==='function') {
      const range=0x1_0000_0000,limit=Math.floor(range/(i+1))*(i+1),sample=new Uint32Array(1);
      do { cryptoApi.getRandomValues(sample); } while(sample[0]>=limit);
      index=sample[0]%(i+1);
    } else index=Math.floor(Math.random()*(i+1));
    [shuffled[i],shuffled[index]]=[shuffled[index],shuffled[i]];
  }
  return shuffled;
}

function chooseSeekers(players,count) {
  const knownHiders=players.filter(player=>player.previousRole==='hider');
  const unknown=players.filter(player=>!['hider','seeker'].includes(player.previousRole));
  const knownSeekers=players.filter(player=>player.previousRole==='seeker');
  const candidates=[...secureShuffle(knownHiders),...secureShuffle(unknown),...secureShuffle(knownSeekers)];
  return new Set(candidates.slice(0,count).map(player=>player.id));
}

export function updateSettings(room, uid, patch) {
  if (room.hostId !== uid || room.phase !== 'lobby') return null;
  room.settings ||= JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const allowed = ['mode','hideDuration','gameDuration','radius','seekerCount','announcements','shrinkingZone','finalRadiusPercent'];
  const safePatch = Object.fromEntries(allowed.filter((key) => key in patch).map((key) => [key, patch[key]]));
  if (patch.center && validPoint(patch.center)) safePatch.center = {lat:patch.center.lat, lng:patch.center.lng};
  const skills = Object.fromEntries(SKILL_IDS.filter((id) => typeof patch.skills?.[id] === 'boolean').map((id) => [id,patch.skills[id]]));
  room.settings = { ...room.settings, ...safePatch, skills:{ ...room.settings.skills, ...skills } };
  if (!['classic','infected'].includes(room.settings.mode)) room.settings.mode = 'classic';
  room.settings.announcements = room.settings.announcements !== false;
  room.settings.shrinkingZone = room.settings.shrinkingZone !== false;
  room.settings.finalRadiusPercent = clamp(Number(room.settings.finalRadiusPercent)||35,25,75);
  room.settings.hideDuration = clamp(Number(room.settings.hideDuration) || 180, 60, 300);
  room.settings.gameDuration = clamp(Number(room.settings.gameDuration) || 1200, 300, 1800);
  room.settings.radius = clamp(Number(room.settings.radius) || 500, 50, 2000);
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
  // Use an unbiased secure shuffle on the first round. On repeats, rotate
  // previous seekers out when possible, choosing randomly among equally due players.
  const seekerIds = chooseSeekers(players,requestedSeekers);
  const hiderSkills = eligibleSkills(room.settings, 'hider');
  const seekerSkills = eligibleSkills(room.settings, 'seeker');
  for (const player of players) {
    player.role = seekerIds.has(player.id) ? 'seeker' : 'hider';
    player.status = player.role === 'seeker' ? 'seeker' : 'hiding';
    player.active = true;
    player.inventory = [];
    player.effects = {};
    player.rewardAt = now();
    player.score=0; player.hidersFound=0; player.skillsUsed=0; player.longestStaySeconds=0; player.hiddenSeconds=0; player.stationarySince=0;
    player._stayAnchor=null; player.hiderStartedAt=0;
    player.coins = Number(player.coins) || 0;
    // Each player receives one random starting skill from the enabled pool for their role.
    const startingPool = player.role === 'seeker' ? seekerSkills : hiderSkills;
    if (startingPool.length) player.inventory.push(randomFrom(startingPool));
  }
  room.phase = 'countdown';
  room.startedAt = now();
  room.phaseEndsAt = now() + 10_000;
  room.matchEndsAt = null;
  room.zonePlan=null;
  room.pendingCatch = null;
  room.itemBoxes = {};
  room.restrictedZones = {};
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
      current.zonePlan=current.settings.shrinkingZone!==false?createZonePlan(current.settings,timestamp):null;
      current.matchEndsAt = timestamp + (Number(current.settings.gameDuration) || 1200) * 1000;
      current.phaseEndsAt = current.matchEndsAt;
      current.lastPhaseTransitionAt = timestamp;
      current.itemBoxes = {};
      for (const player of Object.values(current.players || {})) { player.rewardAt = timestamp; if (player.role==='hider') player.hiderStartedAt=timestamp; }
      current.announcement = { id:randomId('announcement'), type:'system', title:'SEEK PHASE LIVE', message:'Die Jagd ist freigegeben. Signal Caches wurden aktiviert.', createdAt:timestamp };
    } else if (current.phase === 'playing') {
      current.phase = 'finished';
      current.winner = 'hiders';
      current.phaseEndsAt = null;
      awardElapsedHiderPoints(current,timestamp);
      finalizeRound(current,timestamp);
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
    if (!player || room.phase !== 'playing' || player.role !== 'hider' || !player.active) return null;
    const timestamp = Math.min(now(),room.matchEndsAt || now());
    if (!awardPlayerHiderPoints(player,timestamp)) return null;
    return room;
  });
}

export async function updatePlayerLocation(code, uid, location) {
  const remote = remoteAction('updatePlayerLocation', [code, uid, location]);
  if (remote) return remote;
  const timestamp=Number.isFinite(code?.timestamp)?code.timestamp:now();
  return mutateRoom(code, (room) => {
    const player = room.players?.[uid];
    if (!player || !player.active) return null;
    if (!validPoint(location) || !Number.isFinite(location.accuracy) || location.accuracy <= 0 || !Number.isFinite(location.measuredAt) || timestamp - location.measuredAt > 10000 || location.measuredAt > timestamp + 2000) return null;
    player.location = { lat:location.lat, lng:location.lng, accuracy:location.accuracy, measuredAt:location.measuredAt, ...(Number.isFinite(location.altitude) && location.altitude >= -500 && location.altitude <= 10000 ? {altitude:location.altitude} : {}) };
    if (room.phase==='playing' && player.role==='hider' && player.active) {
      const prior=player._stayAnchor;
      if (!prior || timestamp-(prior.lastAt||prior.at||0)>15000 || distanceMeters(prior.point,player.location)>12) {
        if (prior?.at) player.longestStaySeconds=Math.max(Number(player.longestStaySeconds)||0,Math.floor(Math.max(0,(Math.min(timestamp,(prior.lastAt||prior.at)+15000,room.matchEndsAt||timestamp)-prior.at)/1000)));
        player._stayAnchor={point:{lat:player.location.lat,lng:player.location.lng},at:timestamp,lastAt:timestamp};
        player.stationarySince=timestamp;
      } else prior.lastAt=timestamp;
    }
    player.locationAt = timestamp;
    if (!room.settings.center && room.hostId === uid && location.accuracy <= 50) {
      room.settings.center = { lat:player.location.lat, lng:player.location.lng };
    }
    // Traps are resolved transactionally so a seeker's device cannot trigger the same trap twice.
    if (room.phase === 'playing' && player.role === 'seeker' && (player.effects?.frozenUntil || 0) < timestamp) {
      for (const trap of Object.values(room.traps || {})) {
        if (trap.triggeredBy || (trap.expiresAt || 0) <= timestamp) continue;
        if (distanceMeters(player.location, trap.location) <= (trap.radius || 25)) {
          trap.triggeredBy = uid;
          player.effects ||= {};
          player.effects.frozenUntil = timestamp + 15_000;
          room.announcement = { id:randomId('announcement'), type:'private', targetId:uid, title:'EMP TRAP TRIGGERED', message:'Dein Bildschirm ist 15 Sekunden blockiert.', createdAt:timestamp };
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
    if(!freshCatchLocation(seeker,timestamp) || !freshCatchLocation(target,timestamp) || distanceMeters(seeker.location,target.location)>catchDistanceLimit(seeker.location.accuracy,target.location.accuracy)) return null;
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
    awardElapsedHiderPoints(room,timestamp);
    target.effects ||= {};
    if (target.effects.shield === true) {
      target.effects.shield = false;
      room.pendingCatch = null;
      room.announcement = { id:randomId('announcement'), type:'private', targetId, title:'SHIELD ACTIVATED', message:'Dein Schild hat den Fangversuch abgewehrt.', createdAt:timestamp };
      room.announcementForSeeker = { id:randomId('announcement'), targetId:request.seekerId, title:'SHIELD BLOCKED', message:`${target.name} hat einen Schild eingesetzt.`, createdAt:timestamp };
      return room;
    }
    delete target.effects.closecall;
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
    rewardSeekerForCatch(room,seeker,target,timestamp);
    room.pendingCatch = null;
    const nowHiders = Object.values(room.players || {}).filter((player) => player.active && player.role === 'hider');
    const announcementText = room.settings.announcements ? (room.settings.mode === 'infected' ? `${target.name} wurde gefangen und ist nun infiziert!` : `${target.name} wurde gefangen!`) : null;
    room.announcement = announcementText ? { id:randomId('announcement'), type:'global', title:'PLAYER CAPTURED', message:announcementText, createdAt:timestamp, targetId:null } : { id:randomId('announcement'), type:'private', targetId:request.seekerId, title:'CATCH CONFIRMED', message:`${target.name} wurde als gefangen bestätigt.`, createdAt:timestamp };
    if (nowHiders.length === 0) {
      room.phase = 'finished';
      room.winner = 'seekers';
      room.phaseEndsAt = null;
      finalizeRound(room,timestamp);
      room.announcement = { id:randomId('announcement'), type:'global', title:'MISSION COMPLETE', message:room.settings.mode === 'infected' ? 'Alle Hider wurden infiziert.' : 'Alle Hider wurden gefangen.', createdAt:timestamp };
    }
    return room;
  });
}

function freshCatchLocation(player,timestamp) {
  return Boolean(player.location && timestamp-(player.locationAt||0)<=15000 && timestamp>=player.locationAt && Number(player.location.accuracy)<=60);
}
function freshPreciseLocation(player,timestamp) {
  return Boolean(player?.location && timestamp>=(player.locationAt||0) && timestamp-(player.locationAt||0)<=10000 && Number(player.location.accuracy)<=25);
}
function catchDistanceLimit() { return 8; }

function awardPlayerHiderPoints(player,timestamp) {
  if (!player || player.role!=='hider' || !player.hiderStartedAt) return false;
  const until=timestamp;
  const last=Number(player.rewardAt)||Number(player.hiderStartedAt);
  const minutes=Math.floor(Math.max(0,until-last)/60000);
  if (!minutes) return false;
  player.score=(Number(player.score)||0)+minutes;
  player.hiddenSeconds=(Number(player.hiddenSeconds)||0)+minutes*60;
  player.rewardAt=last+minutes*60000;
  return true;
}

export function awardElapsedHiderPoints(room,timestamp=now()) {
  if(!room) return false;
  let changed=false;
  for(const player of Object.values(room.players||{})) changed=awardPlayerHiderPoints(player,Math.min(timestamp,Number(room.matchEndsAt)||timestamp))||changed;
  return changed;
}

function rewardSeekerForCatch(room,seeker,target,timestamp) {
  const remaining=Math.max(1,Object.values(room.players||{}).filter(p=>p.active&&p.role==='hider').length);
  const roundScale=tacticalTuning(room.settings).scale;
  const credits=Math.max(30,Math.round((35+Math.min(10,remaining*3))*roundScale/5)*5);
  const score=Math.max(50,Math.round((65+Math.min(20,remaining*5))*roundScale/5)*5);
  seeker.coins=(Number(seeker.coins)||0)+credits;
  seeker.score=(Number(seeker.score)||0)+score;
  seeker.hidersFound=(Number(seeker.hidersFound)||0)+1;
  room.announcementForSeeker={id:randomId('announcement'),targetId:seeker.id,title:'CATCH REWARD',message:`+${credits} Credits · +${score} Punkte für ${target.name}.`,createdAt:timestamp};
}

function finalizeRound(room,timestamp) {
  for(const player of Object.values(room.players||{})) {
    if(player.role==='hider') {
      awardPlayerHiderPoints(player,Math.min(timestamp,Number(room.matchEndsAt)||timestamp));
      const anchor=player._stayAnchor;
      if(anchor?.at) player.longestStaySeconds=Math.max(Number(player.longestStaySeconds)||0,Math.floor(Math.max(0,(Math.min(timestamp,(anchor.lastAt||anchor.at)+15000,Number(room.matchEndsAt)||timestamp)-anchor.at)/1000)));
    }
  }
  const players=Object.values(room.players||{});
  const awards=[
    ['Sitzratte',p=>Number(p.longestStaySeconds)||0,'Die meiste Zeit am selben Ort'],
    ['Taktikfuchs',p=>Number(p.skillsUsed)||0,'Die meisten Fähigkeiten eingesetzt'],
    ['Fangmaschine',p=>Number(p.hidersFound)||0,'Die meisten Hider gefangen'],
    ['Cache-Krake',p=>Number(p.foundItems)||0,'Die meisten Signal-Caches gefunden'],
    ['Rätselprofi',p=>Number(p.tasksSolved)||0,'Die meisten Aufgaben gelöst'],
    ['Schattenläufer',p=>Number(p.hiddenSeconds)||0,'Am längsten unentdeckt geblieben']
  ].map(([title,score,detail])=>({title,detail,playerId:players.slice().sort((a,b)=>score(b)-score(a))[0]?.id,score:players.reduce((max,p)=>Math.max(max,score(p)),0)})).filter(item=>item.score>0);
  room.roundAchievements=awards;
  room.roundResults=players.map(p=>({id:p.id,name:p.name,role:p.role,status:p.status,score:Number(p.score)||0,coins:Number(p.coins)||0,hidersFound:Number(p.hidersFound)||0,skillsUsed:Number(p.skillsUsed)||0,longestStaySeconds:Number(p.longestStaySeconds)||0,hiddenSeconds:Number(p.hiddenSeconds)||0,foundItems:Number(p.foundItems)||0,tasksSolved:Number(p.tasksSolved)||0})).sort((a,b)=>b.score-a.score||b.hidersFound-a.hidersFound);
  room.roundFinishedAt=timestamp;
}

export function finishRoundIfNoOpposition(room,timestamp=now()) {
  if(!room||!['countdown','reveal','hide','playing'].includes(room.phase)) return false;
  const active=Object.values(room.players||{}).filter(player=>player.active&&player.status!=='left');
  const hiders=active.filter(player=>player.role==='hider');
  const seekers=active.filter(player=>player.role==='seeker');
  let winner=null,reason='';
  if(active.length===1) {
    winner=active[0].role==='hider'?'hiders':'seekers';
    reason='Nur noch ein aktiver Spieler ist im Raum.';
  } else if(active.length>0&&!hiders.length&&seekers.length) {
    winner='seekers'; reason='Es sind keine Hider mehr aktiv.';
  } else if(active.length>0&&!seekers.length&&hiders.length) {
    winner='hiders'; reason='Es sind keine Seeker mehr im Raum.';
  }
  if(!winner) return false;
  room.phase='finished';room.winner=winner;room.phaseEndsAt=null;room.pendingCatch=null;room.photoMetadata={};
  finalizeRound(room,timestamp);
  room.announcement={id:randomId('announcement'),type:'system',title:'MISSION COMPLETE',message:`Runde automatisch beendet. ${reason}`,createdAt:timestamp};
  return true;
}

function applyCatch(room,seekerId,targetId,timestamp) {
  const target=room.players?.[targetId], seeker=room.players?.[seekerId];
  if(!target?.active || !seeker?.active || target.role!=='hider' || seeker.role!=='seeker') return false;
  awardElapsedHiderPoints(room,timestamp);
  room.pendingCatch=null;
  target.effects ||= {};
  if(target.effects.shield===true) {
    target.effects.shield=false;
    room.announcement={id:randomId('announcement'),type:'global',title:'SHIELD ACTIVATED',message:`${target.name} hat den Fang mit einem Schild abgewehrt.`,createdAt:timestamp};
    return true;
  }
  delete target.effects.closecall;
  if(room.settings.mode==='infected') {
    target.role='seeker'; target.status='infected'; target.active=true;
    const available=eligibleSkills(room.settings,'seeker'); target.inventory=available.length?[randomFrom(available)]:[];
  } else {
    target.role='spectator'; target.status='caught'; target.active=false; target.inventory=[];
  }
  rewardSeekerForCatch(room,seeker,target,timestamp);
  room.pendingCatch=null;
  room.announcement=room.settings.announcements===false
    ? {id:randomId('announcement'),type:'private',targetId:seekerId,title:'CATCH CONFIRMED',message:`${target.name} wurde gefangen.`,createdAt:timestamp}
    : {id:randomId('announcement'),type:'global',title:'PLAYER CAPTURED',message:room.settings.mode==='infected'?`${target.name} wurde gefangen und ist nun infiziert!`:`${target.name} wurde gefangen!`,createdAt:timestamp,actorId:seekerId,targetId};
  if(!Object.values(room.players||{}).some(player=>player.active && player.role==='hider')) {
    room.phase='finished'; room.winner='seekers'; room.phaseEndsAt=null; room.photoMetadata={};
    awardElapsedHiderPoints(room,timestamp); finalizeRound(room,timestamp);
    room.announcement={id:randomId('announcement'),type:'global',title:'MISSION COMPLETE',message:room.settings.mode==='infected'?'Alle Hider wurden infiziert.':'Alle Hider wurden gefangen.',createdAt:timestamp};
  }
  return true;
}

export function applyForcedElimination(room,seekerId,targetId,timestamp=now(),reason='relocation') {
  const target=room.players?.[targetId],seeker=room.players?.[seekerId];
  if(!target?.active||target.role!=='hider'||!seeker||seeker.role!=='seeker') return false;
  awardElapsedHiderPoints(room,timestamp);
  target.role='spectator'; target.status='caught'; target.active=false; target.inventory=[];
  target.activeTask=null; target.forcedRelocation=null; target.zoneEvacuations={};
  target.location=null; target.locationAt=0; target.effects={};
  rewardSeekerForCatch(room,seeker,target,timestamp);
  room.announcement={id:randomId('announcement'),type:'global',title:'RELOCATION_FAILED',message:`${target.name} hat die angeordnete ${reason==='zone'?'Sperrzone nicht rechtzeitig verlassen':'Umpositionierung'} nicht abgeschlossen und scheidet aus.`,createdAt:timestamp,actorId:seekerId,targetId};
  if(!Object.values(room.players||{}).some(player=>player.active&&player.role==='hider')) {
    room.phase='finished'; room.winner='seekers'; room.phaseEndsAt=null; room.pendingCatch=null; room.photoMetadata={};
    awardElapsedHiderPoints(room,timestamp); finalizeRound(room,timestamp);
    room.announcement={id:randomId('announcement'),type:'global',title:'MISSION COMPLETE',message:'Alle Hider wurden gefangen oder haben eine Pflichtaufgabe verpasst.',createdAt:timestamp};
  }
  return true;
}

export async function buySkill(code, uid, skillId) {
  const remote = remoteAction('buySkill', [code, uid, skillId]);
  if (remote) return Promise.resolve(remote).then(result=>typeof result==='boolean'?{ok:result,reason:result?'':'Nicht genug Credits oder Fähigkeit aktuell nicht verfügbar.'}:result);
  const skill = SKILLS[skillId];
  if (!skill) return { ok:false, reason:'Unbekannte Fähigkeit.' };
  const result = await mutateRoom(code, (room) => {
    const player = room.players?.[uid];
    if (!player || !player.active || player.role !== skill.side) return null;
    if (room.phase !== 'playing' && !(player.role === 'hider' && room.phase === 'hide')) return null;
    if (room.settings.skills?.[skillId] === false) return null;
    const tuning=skillTuning(skillId,playSettings(room));
    if ((Number(player.coins) || 0) < tuning.price) return null;
    player.coins -= tuning.price;
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
  if (remote) return Promise.resolve(remote).then(result=>typeof result==='boolean'?{ok:result,reason:result?'':'Fähigkeit kann gerade nicht eingesetzt werden. Prüfe Rolle, Phase, Inventar und GPS.'}:result);
  const skill = SKILLS[skillId];
  if (!skill) return { ok:false, reason:'Unbekannte Fähigkeit.' };
  const result = await mutateRoom(code, (room) => {
    const player = room.players?.[uid];
    if (!player || !player.active || player.role !== skill.side) return null;
    const allowedPhase = room.phase === 'playing' || (player.role === 'hider' && room.phase === 'hide');
    if (!allowedPhase || (player.effects?.frozenUntil || 0) > now()) return null;
    const inventoryIndex = (player.inventory || []).indexOf(skillId);
    if (inventoryIndex < 0) return null;
    const timestamp = now();
    const tuning=skillTuning(skillId,playSettings(room));
    if (skillId==='decoy' && !params.location && !player.location) return null;
    if (skillId==='trap' && !player.location) return null;
    if (inventoryIndex >= 0) player.inventory.splice(inventoryIndex, 1);
    player.effects ||= {};
    const expiry = (duration) => timestamp + duration * 1000;
    if (skillId === 'sonar') player.effects.sonarUntil = expiry(tuning.duration);
    else if (skillId === 'tracker' || skillId === 'compass') {
      const hiders = Object.values(room.players || {}).filter((p) => p.active && p.role === 'hider' && p.location && (p.effects?.ghostUntil || 0) < timestamp);
      const from = player.location;
      const sorted = hiders.sort((a,b) => distanceMeters(from,a.location) - distanceMeters(from,b.location));
      const target = skillId === 'compass' ? sorted[sorted.length - 1] : sorted[0];
      if (target) player.effects.trackerTarget = target.id;
      player.effects.trackerUntil = expiry(tuning.duration || 60);
      if (skillId === 'compass') player.effects.compassUntil = expiry(tuning.duration);
    } else if (skillId === 'jammer') room.effects.jammerUntil = expiry(tuning.duration);
    else if (skillId === 'sprint') {
      player.effects.sprintUntil = expiry(tuning.duration);
      room.announcement = { id:randomId('announcement'), type:'global', title:'SPRINT ALARM', message:`${player.name} hat einen Sprint-Alarm aktiviert. Bewegungs-Cues sind live.`, createdAt:timestamp };
    }
    else if (skillId === 'sweeper') {
      const from = player.location;
      let removed = 0;
      for (const [id, trap] of Object.entries(room.traps || {})) {
        if (distanceMeters(from, trap.location) <= tuning.sweepRadius) { delete room.traps[id]; removed++; }
      }
      player.lastActionMessage = `${removed} Falle(n) entfernt.`;
      player.lastActionAt = timestamp;
    } else if (skillId === 'ghost') player.effects.ghostUntil = expiry(tuning.duration);
    else if (skillId === 'decoy') {
      const location = params.location;
      if (!location) return null;
      if (!room.settings.center || distanceMeters(location,room.settings.center)>Math.min(getPlayZone(room,timestamp).radius,tuning.decoyRange)) return null;
      const id = randomId('decoy');
      room.decoys ||= {};
      room.decoys[id] = { id, ownerId:uid, location:{lat:Number(location.lat),lng:Number(location.lng)}, createdAt:timestamp, expiresAt:expiry(tuning.duration) };
    } else if (skillId === 'trap') {
      if (!player.location) return null;
      const id = randomId('trap');
      room.traps ||= {};
      room.traps[id] = { id, ownerId:uid, location:{lat:player.location.lat,lng:player.location.lng}, createdAt:timestamp, expiresAt:expiry(tuning.duration*6), radius:tuning.trapRadius, triggeredBy:null };
    } else if (skillId === 'shield') player.effects.shield = true;
    else if (skillId === 'seekerradar') player.effects.seekerradarUntil = expiry(tuning.duration);
    else if (skillId === 'silent') player.effects.silentUntil = expiry(tuning.duration);
    else if(skillId==='freeze') {
      if(player.role!=='hider'||room.phase!=='playing'||!freshPreciseLocation(player,timestamp)) return null;
      const target=Object.values(room.players||{}).filter(candidate=>candidate.active&&candidate.role==='seeker'&&freshPreciseLocation(candidate,timestamp)&&distanceMeters(player.location,candidate.location)<=tuning.freezeRadius).sort((a,b)=>distanceMeters(player.location,a.location)-distanceMeters(player.location,b.location))[0];
      if(!target) return null;
      if((target.effects?.freezeImmuneUntil||target.effects?.frozenUntil||0)>timestamp) return null;
      target.effects ||= {}; target.effects.frozenUntil=timestamp+tuning.duration*1000; target.effects.freezeImmuneUntil=target.effects.frozenUntil+20000; target.effects.freezeSource='hider';
      room.announcementForSeeker={id:randomId('announcement'),targetId:target.id,title:'FROZEN',message:`Ein Hider hat dich für ${tuning.duration} Sekunden eingefroren.`,createdAt:timestamp};
    }
    player.skillsUsed=(Number(player.skillsUsed)||0)+1;
    room.announcement = { id:randomId('announcement'), type:'private', targetId:uid, title:'SKILL ACTIVATED', message:`${skill.short} eingesetzt.`, createdAt:timestamp };
    return room;
  });
  if (!result) return { ok:false, reason:'Fähigkeit kann gerade nicht eingesetzt werden. Prüfe Rolle, Phase, Inventar und GPS.' };
  return { ok:true };
}

export async function collectItemBox(code, uid, boxId) {
  const remote = remoteAction('collectItemBox', [code, uid, boxId]);
  if (remote) return Promise.resolve(remote).then(result=>typeof result==='boolean'?{ok:result,reason:result?'':'Der Cache ist nicht mehr verfügbar oder GPS ist zu ungenau.'}:result);
  const result = await mutateRoom(code, (room) => {
    const player = room.players?.[uid];
    const box = room.itemBoxes?.[boxId];
    if (!player || !player.active || !box || box.collected || room.phase !== 'playing' || !player.location) return null;
    if (distanceMeters(player.location, box.location) > 10) return null;
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
  if (!result) return { ok:false, reason:'Du bist noch nicht nah genug (10 m), der Cache ist weg oder GPS ist nicht aktiv.' };
  return { ok:true };
}

export async function completeTask(code, uid, reward, proof=null) {
  const remote = remoteAction('completeTask', [code, uid, reward, proof]);
  if (remote) return remote;
  const points = TASK_RULES[reward==='code'?'cipher':reward]?.credits ?? 15;
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
