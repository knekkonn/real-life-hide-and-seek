import * as game from '../js/game-service.js';
import { normalizeRoom } from '../js/transactions.js';
import { evaluateZone, validPoint } from '../js/gps.js';
import { distanceMeters, bearingDegrees, destinationPoint } from '../js/utils.js';

export function publicRoom(source, uid, timestamp=Date.now()) {
  const room = structuredClone(source);
  const self = room.players?.[uid];
  if (!self) {
    if (room.joinRequests?.[uid]) return {code:room.code,phase:'pending',players:{},settings:{}};
    throw new Error('NOT_MEMBER');
  }
  delete room.challenges;
  delete room.processedActions;
  if (room.hostId !== uid) delete room.joinRequests;
  if (room.announcement?.type === 'private' && room.announcement.targetId !== uid) delete room.announcement;
  if (room.announcementForSeeker?.targetId !== uid) delete room.announcementForSeeker;
  if (room.pendingCatch && ![room.pendingCatch.targetId,room.pendingCatch.seekerId].includes(uid)) delete room.pendingCatch;
  const activePhase = room.phase === 'playing' || (room.phase === 'hide' && self.role === 'hider');
  for (const player of Object.values(room.players || {})) {
    if (player.id === uid) continue;
    const effects = self.effects || {};
    const fresh = timestamp - (player.locationAt || 0) <= 10000 && timestamp >= (player.locationAt || 0);
    const ghost = (player.effects?.ghostUntil || 0) > timestamp;
    const sonar = self.role === 'seeker' && player.role === 'hider' && (effects.sonarUntil || 0) > timestamp;
    const tracker = self.role === 'seeker' && player.role === 'hider' && effects.trackerTarget === player.id && (effects.trackerUntil || 0) > timestamp;
    const radar = self.role === 'hider' && player.role === 'seeker' && (effects.seekerradarUntil || 0) > timestamp && (room.effects?.jammerUntil || 0) <= timestamp;
    if (!activePhase || !fresh || !player.active || ghost || !(sonar || tracker || radar)) {
      delete player.location; delete player.locationAt;
    } else if (tracker && (effects.compassUntil || 0) > timestamp && self.location) {
      player.location = destinationPoint(self.location,100,bearingDegrees(self.location,player.location));
    } else if (sonar && !tracker) {
      player.location = {lat:Math.round(player.location.lat*1000)/1000,lng:Math.round(player.location.lng*1000)/1000};
    }
    // Public score/role remain visible; private inventory, effects and zone evidence do not.
    delete player.inventory; delete player.effects; delete player.zone; delete player.previousStatus;
  }
  room.traps = Object.fromEntries(Object.entries(room.traps || {}).filter(([,trap]) => trap.ownerId === uid));
  return room;
}

function member(room,uid) {
  const player = room.players?.[uid];
  if (!player || player.status === 'left') throw new Error('NOT_MEMBER');
  return player;
}
function host(room,uid) { member(room,uid); if (room.hostId !== uid) throw new Error('HOST_ONLY'); }
function validName(name) { return typeof name === 'string' && name.length >= 2 && name.length <= 18 && /^[\p{L}\p{N}_ -]+$/u.test(name); }

export async function applyAction(source, uid, input, timestamp=Date.now()) {
  const room = normalizeRoom(source);
  const context = {room};
  const action = input.action;
  if (action === 'join') {
    if (!validName(input.name)) throw new Error('INVALID_NAME');
    if (room.players[uid] && room.players[uid].status !== 'left') return {room,result:true};
    if (room.phase !== 'lobby') throw new Error('LOBBY_CLOSED');
    room.joinRequests ||= {};
    if (Object.keys(room.joinRequests).length >= 32 && !room.joinRequests[uid]) throw new Error('REQUESTS_FULL');
    room.joinRequests[uid] = {name:input.name,createdAt:timestamp};
    return {room,result:{pending:true}};
  }
  if (action === 'leaveRoom' && room.joinRequests?.[uid] && !room.players[uid]) { delete room.joinRequests[uid]; return {room,result:true}; }
  const player = member(room,uid);
  if (room.phase === 'playing' && (player.effects?.frozenUntil || 0)>timestamp && !['updatePlayerLocation','leaveRoom','respondToCatch'].includes(action)) throw new Error('FROZEN');
  if (room.phase === 'closed') throw new Error('LOBBY_CLOSED');
  if (action === 'approveJoin') {
    host(room,uid);
    const pending = room.joinRequests?.[input.targetId];
    if (!pending || timestamp-pending.createdAt > 300000) throw new Error('REQUEST_EXPIRED');
    const result = game.addPlayerToRoom(room,input.targetId,pending.name);
    if (!result.ok) throw new Error(result.reason);
    delete room.joinRequests[input.targetId];
    return {room,result:true};
  }
  if (action === 'settings') { host(room,uid); return {room:game.updateSettings(room,uid,input.patch || {}),result:true}; }
  if (action === 'start') {
    host(room,uid);
    if (!validPoint(room.settings.center)) throw new Error('CENTER_REQUIRED');
    const result = game.startCountdown(room,uid,null);
    if (!result.ok) throw new Error(result.reason);
    return {room,result:true};
  }
  let result;
  switch (action) {
    case 'advanceExpiredPhase': host(room,uid); result=await game.advanceExpiredPhase(context,room); break;
    case 'maybePayTimeReward': result=await game.maybePayTimeReward(context,uid); break;
    case 'updatePlayerLocation': {
      const location = input.location;
      if (!validPoint(location) || !Number.isFinite(location.accuracy) || location.accuracy<=0 || !Number.isFinite(location.measuredAt) || Math.abs(timestamp-location.measuredAt)>10000) throw new Error('INVALID_GPS');
      let previous = player.zone;
      if (timestamp - (player.locationAt || 0) > 10000) previous = null;
      const zone = evaluateZone(previous,{location:{...location,measuredAt:timestamp},center:room.settings.center,radius:room.settings.radius,connected:true,timestamp});
      zone.violations = previous?.violations || player.zone?.violations || 0;
      zone.counted = previous?.counted && ['warning','outside'].includes(zone.status);
      if (room.phase === 'playing' && zone.status === 'outside' && !zone.counted) {
        zone.violations++; zone.counted=true;
        player.coins = Math.max(0,(player.coins || 0)-5);
        if (zone.violations % 3 === 0) player.effects.frozenUntil=timestamp+30000;
      }
      player.zone=zone;
      result=await game.updatePlayerLocation(context,uid,{...location,measuredAt:timestamp}); break;
    }
    case 'requestCatch': result=await game.requestCatch(context,uid,input.targetId); break;
    case 'respondToCatch':
      if (!input.requestId || input.requestId !== room.pendingCatch?.id || room.pendingCatch?.targetId !== uid || typeof input.accepted !== 'boolean') throw new Error('STALE_CATCH');
      result=await game.respondToCatch(context,uid,input.accepted,input.requestId); break;
    case 'buySkill': result=await game.buySkill(context,uid,input.skillId); break;
    case 'activateSkill': {
      if (input.skillId === 'decoy' && (!validPoint(input.params?.location) || distanceMeters(input.params.location,room.settings.center) > room.settings.radius)) throw new Error('INVALID_POINT');
      if (['tracker','compass','trap','sweeper'].includes(input.skillId) && timestamp-(player.locationAt || 0)>10000) throw new Error('FRESH_GPS_REQUIRED');
      for (const candidate of Object.values(room.players)) if (candidate.id !== uid && timestamp-(candidate.locationAt || 0)>10000) candidate.location=null;
      result=await game.activateSkill(context,uid,input.skillId,input.params || {}); break;
    }
    case 'collectItemBox':
      if (timestamp-(player.locationAt || 0)>10000 || player.location?.accuracy>25) throw new Error('FRESH_GPS_REQUIRED');
      result=await game.collectItemBox(context,uid,input.boxId); break;
    case 'beginTask': {
      if (!player.active || !['hide','playing'].includes(room.phase) || player.role === 'seeker' && room.phase === 'hide') throw new Error('TASK_UNAVAILABLE');
      room.challenges ||= {};
      const old = room.challenges[uid];
      if (old && timestamp-old.createdAt<30000) throw new Error('TASK_COOLDOWN');
      const a=crypto.getRandomValues(new Uint32Array(1))[0]%90+10;
      const b=crypto.getRandomValues(new Uint32Array(1))[0]%90+10;
      const kind=input.kind === 'shake' ? 'shake' : 'code';
      const challenge={id:crypto.randomUUID(),kind,answer:a+b,createdAt:timestamp,expiresAt:timestamp+120000,used:false};
      room.challenges[uid]=challenge;
      return {room,result:{id:challenge.id,kind,prompt:`${a} + ${b}`,expiresAt:challenge.expiresAt}};
    }
    case 'completeTask': {
      const challenge=room.challenges?.[uid];
      if (!challenge || challenge.id!==input.proof?.id || challenge.used || challenge.expiresAt<timestamp || timestamp-challenge.createdAt<3000) throw new Error('INVALID_CHALLENGE');
      if (challenge.kind==='code' && Number(input.proof.answer)!==challenge.answer) throw new Error('WRONG_ANSWER');
      if (challenge.kind==='shake' && timestamp-challenge.createdAt<8000) throw new Error('CHALLENGE_TOO_FAST');
      challenge.used=true;
      result=await game.completeTask(context,uid,challenge.kind); break;
    }
    case 'leaveRoom': result=await game.leaveRoom(context,uid); break;
    default: throw new Error('UNKNOWN_ACTION');
  }
  // Do not leak the complete mutation result (which may include raw GPS).
  return {room:context.room,result:result && typeof result === 'object' && 'ok' in result ? result : Boolean(result)};
}

export async function settlePhases(room) {
  const context = {room};
  for (let i=0;i<5;i++) {
    if (!context.room.phaseEndsAt || context.room.phaseEndsAt>Date.now()) break;
    if (!await game.advanceExpiredPhase(context,context.room)) break;
  }
  return context.room;
}
