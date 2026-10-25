import * as game from '../js/game-service.js';
import { normalizeRoom } from '../js/transactions.js';
import { evaluateZone, validPoint } from '../js/gps.js';
import { distanceMeters, bearingDegrees, destinationPoint } from '../js/utils.js';
import { findSafeItemLocations } from './itembox.js';
import { skillTuning } from '../js/skills.js';

export function publicRoom(source, uid, timestamp=Date.now()) {
  const room = structuredClone(source);
  const self = room.players?.[uid];
  if (!self) {
    if (room.joinRequests?.[uid]) return {code:room.code,phase:'pending',players:{},settings:{}};
    throw new Error('NOT_MEMBER');
  }
  delete room.challenges;
  delete room.objectives;
  const photos = room.photoMetadata || {};
  delete room.photoMetadata;
  if (self.role === 'seeker' && room.phase === 'playing') {
    const roundId=room.roundId || room.startedAt || room.createdAt;
    room.roundPhotos = Object.values(photos).filter(photo => photo.roundId === roundId).map(photo => ({id:photo.playerId, name:room.players[photo.playerId]?.name || 'Hider', createdAt:photo.createdAt}));
  } else delete room.roundPhotos;
  if (self.activeTask) { delete self.activeTask.answer; delete self.activeTask.shift; }
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
    delete player.inventory; delete player.effects; delete player.zone; delete player.previousStatus; delete player.activeTask; delete player.taskCooldownUntil;
    delete player._stayAnchor; delete player.stationarySince; delete player.rewardAt; delete player.hiderStartedAt;
    if (player.id === uid) { /* own task and cooldown remain private to the requesting player */ }
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
  if(room.phase==='playing') game.awardElapsedHiderPoints(room,Math.min(timestamp,Number(room.matchEndsAt)||timestamp));
  if (room.phase === 'playing' && (player.effects?.frozenUntil || 0)>timestamp && !['updatePlayerLocation','leaveRoom'].includes(action)) throw new Error('FROZEN');
  if (room.phase === 'closed' && action !== 'leaveRoom') throw new Error('LOBBY_CLOSED');
  if (action === 'approveJoin') {
    host(room,uid);
    const pending = room.joinRequests?.[input.targetId];
    if (!pending || timestamp-pending.createdAt > 300000) throw new Error('REQUEST_EXPIRED');
    const result = game.addPlayerToRoom(room,input.targetId,pending.name);
    if (!result.ok) throw new Error(result.reason);
    delete room.joinRequests[input.targetId];
    return {room,result:true};
  }
  if (action === 'newRound') {
    host(room,uid); if (room.phase !== 'finished') throw new Error('ROUND_NOT_FINISHED');
    room.phase='lobby'; room.phaseEndsAt=null; room.matchEndsAt=null; room.pendingCatch=null; room.announcement=null; room.winner=null;
    room.challenges={}; room.itemBoxes={}; room.objectives={}; room.traps={}; room.decoys={}; room.effects={}; room.photoMetadata={};
    for (const [id,p] of Object.entries(room.players)) if (!p.active || p.status==='left') delete room.players[id];
    room.roundId=crypto.randomUUID();
    room.roundResults=[]; room.roundAchievements=[];
    for (const p of Object.values(room.players)) { p.active=true; p.role='waiting'; p.status='waiting'; p.coins=0; p.score=0; p.hidersFound=0; p.skillsUsed=0; p.longestStaySeconds=0; p.hiddenSeconds=0; p.stationarySince=0; p._stayAnchor=null; p.hiderStartedAt=0; p.rewardAt=timestamp; p.inventory=[]; p.effects={}; p.location=null; p.locationAt=0; p.activeTask=null; p.taskCooldownUntil=0; p.foundItems=0; p.tasksSolved=0; p.zone={violations:0}; }
    return {room,result:true};
  }
  if (action === 'settings') { host(room,uid); return {room:game.updateSettings(room,uid,input.patch || {}),result:true}; }
  if (action === 'start') {
    host(room,uid);
    if (!validPoint(room.settings.center)) throw new Error('CENTER_REQUIRED');
    const result = game.startCountdown(room,uid,null);
    room.objectives=Object.fromEntries(Array.from({length:5},(_,i)=>[String(i),{id:String(i),location:gameRandomPoint(room.settings.center,room.settings.radius)}]));
    if (!result.ok) throw new Error(result.reason);
    room.roundId=crypto.randomUUID(); room.photoMetadata={};
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
      if (player.activeTask && !player.activeTask.completed && !player.activeTask.failed) {
        const task=player.activeTask;
        if (timestamp>task.expiresAt || task.kind==='stay' && (timestamp-task.lastProofAt>10000 || distanceMeters(location,task.targetLocation)>15)) failTask(player,timestamp);
        else if (task.kind==='stay') task.lastProofAt=timestamp;
        else if (task.kind==='visit' && distanceMeters(location,task.targetLocation)<=task.radius) task.arrivedAt=timestamp;
      }
      result=await game.updatePlayerLocation(context,uid,{...location,measuredAt:timestamp}); break;
    }
    case 'requestCatch': {
      const target=room.players?.[input.targetId];
      if(!target || !target.active || target.role!=='hider') throw new Error('TARGET_NOT_CATCHABLE');
      if(!freshAccurate(player,timestamp) || !freshAccurate(target,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
      if(distanceMeters(player.location,target.location)>5) throw new Error('CATCH_RANGE_REQUIRED');
      result=await game.requestCatch(context,uid,input.targetId); break;
    }
    case 'buySkill': result=await game.buySkill(context,uid,input.skillId); break;
    case 'activateSkill': {
      if (input.skillId === 'decoy' && (!validPoint(input.params?.location) || distanceMeters(input.params.location,room.settings.center) > skillTuning('decoy',room.settings.radius).decoyRange)) throw new Error('INVALID_POINT');
      if (['tracker','compass','trap','sweeper'].includes(input.skillId) && timestamp-(player.locationAt || 0)>10000) throw new Error('FRESH_GPS_REQUIRED');
      for (const candidate of Object.values(room.players)) if (candidate.id !== uid && timestamp-(candidate.locationAt || 0)>10000) candidate.location=null;
      result=await game.activateSkill(context,uid,input.skillId,input.params || {}); break;
    }
    case 'collectItemBox':
      if (timestamp-(player.locationAt || 0)>10000 || player.location?.accuracy>25) throw new Error('FRESH_GPS_REQUIRED');
      result=await game.collectItemBox(context,uid,input.boxId); break;
    case 'beginTask': {
      if (!player.active || player.role !== 'hider' || !['hide','playing'].includes(room.phase)) throw new Error('TASK_UNAVAILABLE');
      if ((player.taskCooldownUntil || 0)>timestamp) throw new Error('TASK_COOLDOWN');
      if (player.activeTask && !player.activeTask.failed && !player.activeTask.completed) { if (player.activeTask.expiresAt>timestamp) throw new Error('TASK_ALREADY_ACTIVE'); failTask(player,timestamp); return {room,result:{error:'TASK_EXPIRED'}}; }
      const kind=['cipher','visit','stay','photo'].includes(input.kind) ? input.kind : 'cipher';
      if (kind==='photo' && room.photoMetadata?.[uid]?.roundId===(room.roundId || room.startedAt || room.createdAt)) throw new Error('PHOTO_ALREADY_SUBMITTED');
      const id=crypto.randomUUID();
      const task={id,kind,createdAt:timestamp,expiresAt:timestamp+(kind==='stay'?180000:kind==='photo'?300000:kind==='cipher'?180000:120000),failed:false,completed:false};
      if (kind==='visit') {
        if (!freshAccurate(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
        const points=Object.values(room.objectives || {}); if (!points.length) throw new Error('NO_OBJECTIVES');
        task.targetLocation=points[crypto.getRandomValues(new Uint32Array(1))[0]%points.length].location;
        task.radius=20;
      }
      if (kind==='stay') { if (!freshAccurate(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED'); task.targetLocation=player.location; task.duration=60000; task.lastProofAt=timestamp; task.progressSince=timestamp; }
      if (kind==='cipher') {
        const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ';
        task.answer=Array.from(crypto.getRandomValues(new Uint8Array(12)),byte=>alphabet[byte%alphabet.length]).join('');
        const keys=['NOVA','LUNA','KITE','ECHO','MINT','WOLF'];
        const key=keys[crypto.getRandomValues(new Uint32Array(1))[0]%keys.length];
        const orders=[[2,0,3,1],[1,3,0,2],[3,1,2,0],[0,2,1,3]];
        const order=orders[crypto.getRandomValues(new Uint32Array(1))[0]%orders.length];
        let transposed='';
        for(const column of order) for(let row=0;row<3;row++) transposed+=task.answer[row*4+column];
        const ciphertext=Array.from(transposed,(char,i)=>String.fromCharCode(65+(char.charCodeAt(0)-65+key.charCodeAt(i%key.length)-65)%26)).join('');
        task.prompt=`KRYPTANALYSE · 180 SEKUNDEN\n1. Vigenère rückwärts: Ziehe den Schlüssel wiederholt Buchstabe für Buchstabe ab (A=0, B=1 … Z=25). Schlüssel: ${key}.\n2. Spaltentransposition rückwärts: Schreibe die 12 Zeichen spaltenweise von oben nach unten in ein Raster mit 3 Zeilen und 4 Spalten. Fülle die Spalten in dieser Reihenfolge: ${order.map(i=>i+1).join('–')}.\n3. Lies das Raster zeilenweise. Gib den 12-stelligen Code ein.\n\nVERSCHLÜSSELTER TEXT: ${transposed.replace(/[A-Z]/g,c=>String.fromCharCode(65+(c.charCodeAt(0)-65+key.charCodeAt(0)-65)%26))}`;
        task.prompt=`KRYPTANALYSE · 180 SEKUNDEN\n1. Vigenère rückwärts: Ziehe den Schlüssel wiederholt Buchstabe für Buchstabe ab (A=0, B=1 … Z=25). Schlüssel: ${key}.\n2. Spaltentransposition rückwärts: Schreibe die 12 Zeichen spaltenweise von oben nach unten in ein Raster mit 3 Zeilen und 4 Spalten. Fülle die Spalten in dieser Reihenfolge: ${order.map(i=>i+1).join('–')}.\n3. Lies das Raster zeilenweise. Gib den 12-stelligen Code ein.\n\nVERSCHLÜSSELTER TEXT: ${ciphertext}`;
      }
      player.activeTask=task;
      return {room,result:{id,kind,prompt:task.prompt,targetLocation:task.targetLocation,expiresAt:task.expiresAt,duration:task.duration}};
    }
    case 'submitPhoto': {
      const task=player.activeTask;
      const image=input.image;
      if (!task || task.kind!=='photo' || task.id!==input.taskId || task.failed || task.completed || task.expiresAt<timestamp || !player.active || player.role!=='hider' || !['hide','playing'].includes(room.phase)) { if(task && task.kind==='photo' && !task.completed) { failTask(player,timestamp); return {room,result:{error:'INVALID_CHALLENGE'}}; } throw new Error('INVALID_CHALLENGE'); }
      if (typeof image!=='string' || image.length>25500 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) { failTask(player,timestamp); return {room,result:{error:'INVALID_PHOTO'}}; }
      let bytes; try { bytes=Uint8Array.from(atob(image.slice(image.indexOf(',')+1)),char=>char.charCodeAt(0)); } catch { failTask(player,timestamp); return {room,result:{error:'INVALID_PHOTO'}}; }
      if (bytes.length<100 || bytes.length>18500 || !isSanitizedJpeg(bytes)) { failTask(player,timestamp); return {room,result:{error:'INVALID_PHOTO'}}; }
      room.photoMetadata ||= {};
      room.photoMetadata[uid]={playerId:uid,roundId:room.roundId || room.startedAt || room.createdAt,image,createdAt:timestamp};
      task.completed=true; player.taskCooldownUntil=timestamp+30000;
      result=await game.completeTask(context,uid,'photo'); break;
    }
    case 'failTask': { const task=player.activeTask; if (!task || task.id!==input.taskId || task.completed) throw new Error('INVALID_CHALLENGE'); failTask(player,timestamp); result=true; break; }
    case 'completeTask': {
      const task=player.activeTask;
      if (!task || task.id!==input.proof?.id || task.failed || task.completed || task.expiresAt<timestamp) {
        if (task && !task.completed) { failTask(player,timestamp); return {room,result:{error:'INVALID_CHALLENGE'}}; }
        throw new Error('INVALID_CHALLENGE');
      }
      if (task.kind==='cipher') {
        if (timestamp-task.createdAt<30000) { failTask(player,timestamp); return {room,result:{error:'TASK_TOO_FAST'}}; }
        if (String(input.proof.answer||'').trim().toUpperCase()!==task.answer) { failTask(player,timestamp); return {room,result:{error:'WRONG_ANSWER'}}; }
      } else if (task.kind==='visit') {
        if (!freshAccurate(player,timestamp) || distanceMeters(player.location,task.targetLocation)>task.radius) { failTask(player,timestamp); return {room,result:{error:'TASK_LOCATION_REQUIRED'}}; }
      } else if (task.kind==='stay') {
        if (timestamp-task.lastProofAt>10000 || timestamp-task.progressSince<task.duration || !freshAccurate(player,timestamp) || distanceMeters(player.location,task.targetLocation)>15) { failTask(player,timestamp); return {room,result:{error:'TASK_NOT_HELD'}}; }
      } else throw new Error('UNKNOWN_TASK');
      if(task.kind==='visit' && !task.arrivedAt) { failTask(player,timestamp); return {room,result:{error:'TASK_LOCATION_REQUIRED'}}; }
      task.completed=true; player.taskCooldownUntil=timestamp+30000;
      result=await game.completeTask(context,uid,task.kind==='cipher'?'code':task.kind); break;
    }
    case 'leaveRoom':
      if (room.players[uid]) { room.players[uid].active=false; room.players[uid].status='left'; room.players[uid].location=null; room.players[uid].locationAt=0; room.players[uid].zone={}; room.players[uid].activeTask=null; }
      if (uid===room.hostId && room.phase==='lobby') room.phase='closed';
      if (uid===room.hostId && room.phase!=='closed' && room.phase!=='lobby') {
        const successor=Object.values(room.players).filter(p=>p.active && p.status!=='left').sort((a,b)=>(a.joinedAt||0)-(b.joinedAt||0))[0];
        if(successor) { room.players[uid].isHost=false; successor.isHost=true; room.hostId=successor.id; }
      }
      if(room.photoMetadata) delete room.photoMetadata[uid];
      result=true;
      if (Object.values(room.players).every(p=>!p.active || p.status==='left')) {
        room.phase='closed'; room.closedAt=timestamp; room.players={}; room.hostId=null; room.joinRequests={}; room.challenges={}; room.objectives={}; room.traps={}; room.decoys={}; room.itemBoxes={}; room.effects={}; room.photoMetadata={}; room.eventLog=[]; room.pendingCatch=null; room.announcement=null; room.announcementForSeeker=null; room.winner=null; room.startedAt=null; room.matchEndsAt=null; room.settings.center=null; delete room.roundPhotos;
      }
      break;
    default: throw new Error('UNKNOWN_ACTION');
  }
  // Do not leak the complete mutation result (which may include raw GPS).
  if (room.phase==='finished') room.photoMetadata={};
  return {room:context.room,result:result && typeof result === 'object' && 'ok' in result ? result : Boolean(result)};
}

export async function settlePhases(room, fetchImpl=fetch) {
  const context = {room};
  game.awardElapsedHiderPoints(room,Math.min(Date.now(),Number(room.matchEndsAt)||Date.now()));
  for (let i=0;i<5;i++) {
    if (!context.room.phaseEndsAt || context.room.phaseEndsAt>Date.now()) break;
    const previous=context.room.phase;
    if (!await game.advanceExpiredPhase(context,context.room)) break;
    if(previous==='hide' && context.room.phase==='playing') {
      context.room.itemBoxes={};
      const points=await findSafeItemLocations(context.room.settings.center,Number(context.room.settings.radius)||500,fetchImpl);
      for(const {location,level,layer} of points) {
        const id=crypto.randomUUID();
        context.room.itemBoxes[id]={id,location,createdAt:Date.now(),collected:false,type:Math.random()<.72?'credits':'skill',...(level===undefined?{}:{level}),...(layer===undefined?{}:{layer})};
      }
      context.room.announcement={id:crypto.randomUUID(),type:'system',title:'SEEK PHASE LIVE',message:points.length?`${points.length} Signal Caches auf öffentlich kartierten Wegen aktiviert.`:'Keine Signal Caches: Für diese Zone sind keine geeigneten öffentlichen Wege verzeichnet.',createdAt:Date.now()};
    }
  }
  if(context.room.phase==='finished') context.room.photoMetadata={};
  return context.room;
}

function failTask(player,timestamp) { if (!player.activeTask) return; player.activeTask.failed=true; player.taskCooldownUntil=timestamp+120000; }
function freshAccurate(player,timestamp) { return player.location && timestamp-(player.locationAt||0)<=10000 && Number(player.location.accuracy)<=25; }
function gameRandomPoint(center,radius) { const angle=Math.random()*360, distance=Math.sqrt(Math.random())*Math.max(0,radius-40); return destinationPoint(center,distance,angle); }
function isSanitizedJpeg(bytes) {
  if(bytes[0]!==0xff || bytes[1]!==0xd8) return false;
  let offset=2, hasFrame=false, hasEnd=false;
  const frameMarkers=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  while(offset<bytes.length) {
    if(bytes[offset]!==0xff) return false;
    while(bytes[offset]===0xff) offset++;
    const marker=bytes[offset++];
    if(marker===0x00) continue;
    if(marker===0xd9) { hasEnd=true; break; }
    if(marker===0xd8 || marker===0x01 || marker>=0xd0&&marker<=0xd7) continue;
    if(offset+1>=bytes.length) return false;
    const segmentLength=(bytes[offset]<<8)|bytes[offset+1];
    if(segmentLength<2 || offset+segmentLength>bytes.length) return false;
    if(marker===0xe1) return false; // APP1 contains EXIF/XMP metadata and is never needed in a browser-reencoded photo.
    if(frameMarkers.has(marker)) {
      if(segmentLength<8) return false;
      const data=offset+2, height=(bytes[data+1]<<8)|bytes[data+2], width=(bytes[data+3]<<8)|bytes[data+4];
      if(!width || !height || width>320 || height>240) return false;
      hasFrame=true;
    }
    offset+=segmentLength;
    if(marker===0xda) {
      while(offset+1<bytes.length) {
        if(bytes[offset]===0xff && bytes[offset+1]!==0x00 && !(bytes[offset+1]>=0xd0&&bytes[offset+1]<=0xd7)) break;
        if(bytes[offset]===0xff) offset+=2; else offset++;
      }
    }
  }
  return hasFrame && hasEnd && offset===bytes.length;
}
