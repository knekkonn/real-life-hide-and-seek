import * as game from '../js/game-service.js';
import { normalizeRoom } from '../js/transactions.js';
import { evaluateZone, validPoint, getPlayZone, playSettings } from '../js/gps.js';
import { distanceMeters, bearingDegrees, destinationPoint } from '../js/utils.js';
import { findSafeItemLocations } from './itembox.js';
import { skillTuning, tacticalTuning, TASK_RULES } from '../js/skills.js';
import { COSMETIC_IDS } from '../js/profile.js';

export function publicRoom(source, uid, timestamp=Date.now()) {
  const room = structuredClone(source);
  const self = room.players?.[uid];
  if (!self || self.status==='left') {
    throw new Error('NOT_MEMBER');
  }
  delete room.challenges;
  delete room.objectives;
  room.restrictedZones=Object.fromEntries(Object.entries(room.restrictedZones||{}).filter(([,zone])=>zone.expiresAt>timestamp).map(([id,zone])=>{const {allowedInside,...publicZone}=zone;return [id,publicZone];}));
  const photos = room.photoMetadata || {};
  delete room.photoMetadata;
  if (self.role === 'seeker' && room.phase === 'playing') {
    const roundId=room.roundId || room.startedAt || room.createdAt;
    room.roundPhotos = Object.values(photos).filter(photo => photo.roundId === roundId).map(photo => ({id:photo.playerId, name:room.players[photo.playerId]?.name || 'Hider', createdAt:photo.createdAt}));
  } else delete room.roundPhotos;
  if (self.activeTask) { delete self.activeTask.answer; delete self.activeTask.shift; }
  delete room.processedActions;
  if(room.phase!=='finished') delete room.roundTracks;
  else room.roundTracks=Object.fromEntries(Object.entries(room.roundTracks||{}).map(([id,track])=>[id,{distanceMeters:Number(track.distanceMeters)||0,points:(Array.isArray(track.points)?track.points:[]).filter(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)&&Math.abs(point[0])<=90&&Math.abs(point[1])<=180).slice(-240)}]));
  delete room.joinRequests;
  if (room.announcement?.type === 'private' && room.announcement.targetId !== uid) delete room.announcement;
  if (room.announcementForSeeker?.targetId !== uid) delete room.announcementForSeeker;
  if (room.pendingCatch && ![room.pendingCatch.targetId,room.pendingCatch.seekerId].includes(uid)) delete room.pendingCatch;
  const activePhase = room.phase === 'playing' || (room.phase === 'hide' && self.role === 'hider');
  for (const player of Object.values(room.players || {})) {
    player.inventory=(player.inventory||[]).filter(id=>id!=='closecall');
    if(player.effects) delete player.effects.closecall;
    if (player.id === uid) { delete player.previousRole; if(player.activeTask) delete player.activeTask.seekerId; continue; }
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
    delete player.inventory; delete player.effects; delete player.zone; delete player.previousStatus; delete player.previousRole; delete player.activeTask; delete player.taskCooldownUntil; delete player.forcedRelocation; delete player.zoneEvacuations; delete player.tacticalCooldowns; delete player.timeExchangesUsed;
    delete player._stayAnchor; delete player.stationarySince; delete player.rewardAt; delete player.hiderStartedAt; delete player.closeCallUsed;
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
function codeFeedback(code,guess) {
  let exact=0,present=0;
  for(let i=0;i<3;i++) { if(code[i]===guess[i]) exact++; if(code.includes(guess[i])) present++; }
  return {exact,misplaced:present-exact};
}
function sameFeedback(a,b) { return a.exact===b.exact && a.misplaced===b.misplaced; }
function puzzleCodes() {
  const codes=[];
  for(let a=0;a<10;a++) for(let b=0;b<10;b++) for(let c=0;c<10;c++) if(a!==b&&a!==c&&b!==c) codes.push(`${a}${b}${c}`);
  return codes;
}
function randomIndex(max) { return crypto.getRandomValues(new Uint32Array(1))[0]%max; }
function makeLogicCodePuzzle() {
  const codes=puzzleCodes(),answer=codes[randomIndex(codes.length)];
  for(let attempt=0;attempt<32;attempt++) {
    const guesses=[];
    while(guesses.length<5) { const guess=codes[randomIndex(codes.length)]; if(guess!==answer&&!guesses.includes(guess)) guesses.push(guess); }
    const clues=guesses.map(guess=>({guess,...codeFeedback(answer,guess)}));
    const solutions=codes.filter(candidate=>clues.every(clue=>sameFeedback(codeFeedback(candidate,clue.guess),clue)));
    if(solutions.length===1) return {answer,clues};
  }
  // Rare fallback: keep adding informative guesses until the clues identify
  // the code uniquely. This guarantees a valid challenge without leaking it.
  let solutions=codes.slice(); const clues=[];
  for(let guess of codes) {
    if(guess===answer) continue;
    const clue={guess,...codeFeedback(answer,guess)};
    const filtered=solutions.filter(candidate=>sameFeedback(codeFeedback(candidate,guess),clue));
    if(filtered.length<solutions.length) { clues.push(clue); solutions=filtered; }
    if(solutions.length===1) break;
  }
  return {answer,clues};
}

export async function applyAction(source, uid, input, timestamp=Date.now(), fetchImpl=fetch) {
  const room = normalizeRoom(source);
  const context = {room,timestamp};
  const action = input.action;
  if (action === 'join') {
    if (!validName(input.name)) throw new Error('INVALID_NAME');
    if (room.players[uid] && room.players[uid].status !== 'left') return {room,result:true};
    if (room.phase !== 'lobby') throw new Error('LOBBY_CLOSED');
    const added=game.addPlayerToRoom(room,uid,input.name);
    if (!added.ok) {
      if (added.reason.includes('voll')) throw new Error('ROOM_FULL');
      if (added.reason.includes('Codename')) throw new Error('NAME_IN_USE');
      throw new Error('LOBBY_CLOSED');
    }
    // Clear requests left by clients running the former host-approval flow.
    delete room.joinRequests;
    return {room,result:true};
  }
  const player = member(room,uid);
  settleZoneTasks(room,timestamp);
  if(room.phase==='playing') {
    game.awardElapsedHiderPoints(room,Math.min(timestamp,Number(room.matchEndsAt)||timestamp));
    // A location update can arrive just after its deadline even though its
    // GPS sample was captured before it. Let deadline settlement consider
    // that validated sample so a delayed network packet cannot wrongly
    // eliminate a player who completed the move in time.
    const locationProof=action==='updatePlayerLocation'&&validPoint(input.location)&&Number.isFinite(input.location.accuracy)&&input.location.accuracy>0&&input.location.accuracy<=25&&Number.isFinite(input.location.measuredAt)&&Math.abs(timestamp-input.location.measuredAt)<=10000?input.location:null;
    settleTacticalDeadlines(room,timestamp,{playerId:uid,location:locationProof});
    if(!player.active && action!=='leaveRoom') return {room,result:false};
  }
  if (room.phase === 'playing' && (player.effects?.frozenUntil || 0)>timestamp && !['updatePlayerLocation','leaveRoom'].includes(action)) throw new Error('FROZEN');
  if (room.phase === 'playing' && player.role==='hider' && player.forcedRelocation && !['updatePlayerLocation','leaveRoom'].includes(action)) throw new Error('RELOCATION_REQUIRED');
  if (room.phase === 'closed' && action !== 'leaveRoom') throw new Error('LOBBY_CLOSED');
  if (action === 'newRound' || action === 'restartRound') {
    host(room,uid);
    if (room.phase !== 'finished') throw new Error('ROUND_NOT_FINISHED');
    if(action==='restartRound') {
      const roster=Object.values(room.players||{}).filter(p=>p?.status!=='left');
      const seekers=Math.max(1,Math.min(10,Number(room.settings?.seekerCount)||1));
      if(roster.length<2) throw new Error('NOT_ENOUGH_PLAYERS');
      if(seekers>=roster.length) throw new Error('NOT_ENOUGH_HIDERS');
      if(!validPoint(room.settings?.center)) throw new Error('CENTER_REQUIRED');
    }
    resetRoomForNextRound(room,timestamp);
    if(action==='newRound') return {room,result:true};
    const started=game.startCountdown(room,uid,null);
    if(!started.ok) throw new Error('ROUND_RESTART_FAILED');
    room.objectives=Object.fromEntries(Array.from({length:5},(_,i)=>[String(i),{id:String(i),location:gameRandomPoint(room.settings.center,room.settings.radius)}]));
    room.photoMetadata={}; room.roundTracks={};
    return {room,result:true};
  }
  if (action === 'settings') { host(room,uid); return {room:game.updateSettings(room,uid,input.patch || {}),result:true}; }
  if (action === 'start') {
    host(room,uid);
    if (!validPoint(room.settings.center)) {
      if (!freshAccurate(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
      room.settings.center={lat:player.location.lat,lng:player.location.lng};
    }
    const result = game.startCountdown(room,uid,null);
    room.objectives=Object.fromEntries(Array.from({length:5},(_,i)=>[String(i),{id:String(i),location:gameRandomPoint(room.settings.center,room.settings.radius)}]));
    if (!result.ok) throw new Error(result.reason);
    room.roundId=crypto.randomUUID(); room.photoMetadata={}; room.roundTracks={};
    return {room,result:true};
  }
  let result;
  switch (action) {
    case 'advanceExpiredPhase': {
      host(room,uid); const previous=room.phase;
      result=await game.advanceExpiredPhase(context,room);
      if(previous==='hide'&&room.phase==='playing') await spawnItemBoxes(room,fetchImpl,timestamp);
      break;
    }
    case 'maybePayTimeReward': result=await game.maybePayTimeReward(context,uid); break;
    case 'updatePlayerLocation': {
      const location = input.location;
      if (!validPoint(location) || !Number.isFinite(location.accuracy) || location.accuracy<=0 || !Number.isFinite(location.measuredAt) || timestamp-location.measuredAt>10000 || location.measuredAt>timestamp+2000) throw new Error('INVALID_GPS');
      if(room.phase==='playing' && player.role==='hider') {
        for(const zone of Object.values(room.restrictedZones||{})) {
          if(zone.expiresAt<=timestamp || distanceMeters(location,zone.center)>zone.radius) continue;
          const obligation=player.zoneEvacuations?.[zone.id];
          const mayRemainInside=Boolean(obligation&&obligation.deadlineAt>timestamp&&freshAccurate(player,timestamp)&&distanceMeters(player.location,zone.center)<=zone.radius);
          if(!mayRemainInside) throw new Error('RESTRICTED_AREA');
        }
      }
      let previous = player.zone;
      if (timestamp - (player.locationAt || 0) > 10000) previous = null;
      const zone = evaluateZone(previous,{location:{...location,measuredAt:timestamp},center:room.settings.center,radius:getPlayZone(room,timestamp).radius,connected:true,timestamp,enabled:room.settings.zoneEnabled!==false});
      zone.violations = previous?.violations || player.zone?.violations || 0;
      zone.counted = previous?.counted && ['warning','outside'].includes(zone.status);
      if (room.phase === 'playing' && zone.status === 'outside' && !zone.counted) {
        zone.violations++; zone.counted=true;
        player.coins = Math.max(0,(player.coins || 0)-5);
        if (zone.violations % 3 === 0) player.effects.frozenUntil=timestamp+30000;
      }
      player.zone=zone;
      recordRoundTrack(room,player,location,timestamp);
      let autoCompleteVisit=false;
      if (player.activeTask && !player.activeTask.completed && !player.activeTask.failed) {
        const task=player.activeTask;
        if (!['photo','closecall'].includes(task.kind) && (timestamp>task.expiresAt || task.kind==='stay' && (timestamp-task.lastProofAt>10000 || distanceMeters(location,task.targetLocation)>10))) failTask(player,timestamp);
        else if (task.kind==='stay') task.lastProofAt=timestamp;
        else if (['visit','scan'].includes(task.kind) && freshAccurate({...player,location,locationAt:timestamp},timestamp) && distanceMeters(location,task.targetLocation)<=task.radius) { task.arrivedAt=timestamp; autoCompleteVisit=task.kind==='visit'; }
        else if (task.kind==='proximity' && hasNearbyHider(room,uid,location,timestamp,10)) task.arrivedAt=timestamp;
      }
      await game.updatePlayerLocation(context,uid,location);
      await settleRiskTasks(room,timestamp);
      if(player.role==='hider') {
        player.zoneEvacuations ||= {};
        for(const zone of Object.values(room.restrictedZones||{})) if(freshAccurate(player,timestamp)&&distanceMeters(player.location,zone.center)>zone.radius) {
          zone.allowedInside=(zone.allowedInside||[]).filter(id=>id!==uid);
          delete player.zoneEvacuations[zone.id];
        }
      }
      if(player.forcedRelocation && freshAccurate(player,timestamp) && distanceMeters(player.location,player.forcedRelocation.from)>=player.forcedRelocation.minimumMeters) {
        player.forcedRelocation=null;
        room.announcement={id:crypto.randomUUID(),type:'private',targetId:uid,title:'RELOCATION_COMPLETE',message:'Mindestabstand erreicht. Du kannst wieder Fähigkeiten und Aufgaben einsetzen.',createdAt:timestamp};
      }
      if(autoCompleteVisit && player.activeTask && !player.activeTask.completed && !player.activeTask.failed) {
        player.activeTask.completed=true; player.activeTask.completedAt=timestamp; player.taskCooldownUntil=timestamp+30000;
        result=await game.completeTask(context,uid,'visit');
      } else result=true;
      break;
    }
    case 'requestCatch': {
      const target=room.players?.[input.targetId];
      if(!target || !target.active || target.role!=='hider') throw new Error('TARGET_NOT_CATCHABLE');
      if(!freshCatchLocation(player,timestamp) || !freshCatchLocation(target,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
      if(distanceMeters(player.location,target.location)>catchDistanceLimit(player.location.accuracy,target.location.accuracy)) throw new Error('CATCH_RANGE_REQUIRED');
      result=await game.requestCatch(context,uid,input.targetId); break;
    }
    case 'buySkill': result=await game.buySkill(context,uid,input.skillId); break;
    case 'activateSkill': {
      if (input.skillId === 'decoy' && (!validPoint(input.params?.location) || distanceMeters(input.params.location,room.settings.center) > Math.min(getPlayZone(room,timestamp).radius,skillTuning('decoy',playSettings(room,timestamp)).decoyRange))) throw new Error('INVALID_POINT');
      if (['tracker','compass','trap','sweeper','freeze'].includes(input.skillId) && !freshAccurate(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
      if(input.skillId==='freeze') {
        if(player.role!=='hider'||room.phase!=='playing'||!(player.inventory||[]).includes('freeze')) throw new Error('SKILL_UNAVAILABLE');
        const tuning=skillTuning('freeze',playSettings(room,timestamp));
        const target=Object.values(room.players||{}).filter(candidate=>candidate.active&&candidate.role==='seeker'&&freshAccurate(candidate,timestamp)&&distanceMeters(player.location,candidate.location)<=tuning.freezeRadius).sort((a,b)=>distanceMeters(player.location,a.location)-distanceMeters(player.location,b.location))[0];
        if(!target) throw new Error('SEEKER_NOT_NEARBY');
        if((target.effects?.freezeImmuneUntil||target.effects?.frozenUntil||0)>timestamp) throw new Error('ABILITY_COOLDOWN');
        player.inventory.splice(player.inventory.indexOf('freeze'),1); player.skillsUsed=(Number(player.skillsUsed)||0)+1;
        target.effects ||= {}; target.effects.frozenUntil=timestamp+tuning.duration*1000; target.effects.freezeImmuneUntil=target.effects.frozenUntil+20000; target.effects.freezeSource='hider';
        room.announcement={id:crypto.randomUUID(),type:'private',targetId:uid,title:'FROST_IMPULSE',message:`Seeker für ${tuning.duration} Sekunden eingefroren.`,createdAt:timestamp};
        room.announcementForSeeker={id:crypto.randomUUID(),targetId:target.id,title:'FROZEN',message:`Ein Hider hat dich für ${tuning.duration} Sekunden eingefroren.`,createdAt:timestamp};
        result=true;
      } else result=await game.activateSkill(context,uid,input.skillId,input.params || {});
      for (const candidate of Object.values(room.players)) if (candidate.id !== uid && timestamp-(candidate.locationAt || 0)>10000) candidate.location=null;
      break;
    }
    case 'useTacticalAbility': result=useTacticalAbility(room,player,input,timestamp); break;
    case 'collectItemBox':
      if(!taskPointAvailable(room,room.itemBoxes?.[input.boxId]?.location,timestamp)) throw new Error('NO_OBJECTIVES');
      if (timestamp-(player.locationAt || 0)>10000 || player.location?.accuracy>25) throw new Error('FRESH_GPS_REQUIRED');
      result=await game.collectItemBox(context,uid,input.boxId); break;
    case 'beginTask': {
      const kind=input.kind;
      const hiderKind=['cipher','visit','stay','photo','closecall'].includes(kind);
      const seekerKind=['scan','proximity'].includes(kind);
      if (!player.active || !(player.role==='hider'&&hiderKind || player.role==='seeker'&&seekerKind) || (player.role==='hider'&&!['hide','playing'].includes(room.phase)) || (player.role==='seeker'&&room.phase!=='playing')) throw new Error('TASK_UNAVAILABLE');
      if ((player.taskCooldownUntil || 0)>timestamp) throw new Error('TASK_COOLDOWN');
      if(kind==='closecall' && player.closeCallUsed) throw new Error('TASK_ALREADY_USED');
      if (player.activeTask && !player.activeTask.failed && !player.activeTask.completed) { if (player.activeTask.expiresAt>timestamp) throw new Error('TASK_ALREADY_ACTIVE'); failTask(player,timestamp); return {room,result:{error:'TASK_EXPIRED'}}; }
      if (kind==='photo' && room.photoMetadata?.[uid]?.roundId===(room.roundId || room.startedAt || room.createdAt)) throw new Error('PHOTO_ALREADY_SUBMITTED');
      const id=crypto.randomUUID();
      const task={id,kind,createdAt:timestamp,expiresAt:timestamp+(kind==='stay'?180000:kind==='photo'?300000:kind==='cipher'?150000:120000),failed:false,completed:false};
      if(kind==='closecall') {
        if(room.phase!=='playing') throw new Error('TASK_UNAVAILABLE');
        const seeker=nearbyTaskSeeker(room,player,timestamp);
        if(!seeker) throw new Error('SEEKER_NOT_NEARBY');
        player.closeCallUsed=true;
        task.duration=TASK_RULES.closecall.seconds*1000; task.radius=TASK_RULES.closecall.radius;
        task.expiresAt=Math.min(timestamp+task.duration,Number(room.matchEndsAt)||Infinity);
        task.lastProofAt=timestamp; task.seekerId=seeker.id; task.verifiedMs=0; task.pointsAwarded=0;
      }
      if (kind==='visit') {
        if (!freshAccurate(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
        const points=Object.values(room.objectives || {}).filter(point=>taskPointAvailable(room,point.location,task.expiresAt)); if (!points.length) throw new Error('NO_OBJECTIVES');
        task.targetLocation=points[crypto.getRandomValues(new Uint32Array(1))[0]%points.length].location;
        task.radius=10;
      }
      if (kind==='scan') {
        if (!freshAccurate(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
        const boxes=Object.values(room.itemBoxes||{}).filter(box=>!box.collected&&taskPointAvailable(room,box.location,task.expiresAt));
        if (!boxes.length) throw new Error('NO_OBJECTIVES');
        const box=boxes[crypto.getRandomValues(new Uint32Array(1))[0]%boxes.length];
        task.targetLocation=box.location; task.targetBoxId=box.id; task.radius=10;
      }
      if (kind==='proximity') {
        if (!freshAccurate(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
        if (!Object.values(room.players||{}).some(candidate=>candidate.active&&candidate.role==='hider'&&freshAccurate(candidate,timestamp))) throw new Error('NO_OBJECTIVES');
      }
      if (kind==='stay') { if (!freshAccurate(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED'); if(!taskPointAvailable(room,player.location,timestamp+60000)) throw new Error('TASK_ZONE_REQUIRED'); task.targetLocation=player.location; task.duration=60000; task.lastProofAt=timestamp; task.progressSince=timestamp; }
      if (kind==='cipher') {
        const puzzle=makeLogicCodePuzzle(); task.answer=puzzle.answer;
        task.attemptsLeft=3;
        task.prompt=`TRESORCODE · 150 SEKUNDEN\nFinde den 3-stelligen Code. Alle drei Ziffern sind verschieden.\nJe Hinweis siehst du, wie viele Ziffern richtig platziert sind und wie viele zwar vorkommen, aber an der falschen Stelle stehen.\n\n${puzzle.clues.map(clue=>`${clue.guess} → ${clue.exact} richtig platziert · ${clue.misplaced} an anderer Stelle`).join('\n')}`;
      }
      if (kind==='scan') task.prompt='Signal Cache scannen · Gehe zum markierten Cache und schließe den Scan in 120 Sekunden innerhalb von 10 m ab.';
      if (kind==='proximity') task.prompt='Hider-Signal aufspüren · Komme innerhalb von 120 Sekunden auf 10 m an einen aktiven Hider heran. Der Server prüft die Nähe, gibt aber keine fremde GPS-Position frei.';
      player.activeTask=task;
      return {room,result:{id,kind,prompt:task.prompt,targetLocation:task.targetLocation,expiresAt:task.expiresAt,duration:task.duration}};
    }
    case 'submitPhoto': {
      const task=player.activeTask;
      const image=input.image;
      if (!task || task.kind!=='photo' || task.id!==input.taskId || task.failed || task.completed || task.expiresAt<timestamp || !player.active || player.role!=='hider' || !['hide','playing'].includes(room.phase)) { if(task && task.kind==='photo' && !task.completed) { failTask(player,timestamp); return {room,result:{error:'INVALID_CHALLENGE'}}; } throw new Error('INVALID_CHALLENGE'); }
      if(task.photoSubmittedAt) throw new Error('PHOTO_ALREADY_SUBMITTED');
      if(!freshTaskGps(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
      if(!taskPointAvailable(room,player.location,timestamp+TASK_RULES.photo.seconds*1000)) throw new Error('TASK_ZONE_REQUIRED');
      if(room.phase==='playing' && Number(room.matchEndsAt)-timestamp<TASK_RULES.photo.seconds*1000) throw new Error('TASK_TIME_REQUIRED');
      if (typeof image!=='string' || image.length>25500 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) { failTask(player,timestamp); return {room,result:{error:'INVALID_PHOTO'}}; }
      let bytes; try { bytes=Uint8Array.from(atob(image.slice(image.indexOf(',')+1)),char=>char.charCodeAt(0)); } catch { failTask(player,timestamp); return {room,result:{error:'INVALID_PHOTO'}}; }
      const sanitized=sanitizeJpeg(bytes);
      if (!sanitized || sanitized.length<100 || sanitized.length>18500) { failTask(player,timestamp); return {room,result:{error:'INVALID_PHOTO'}}; }
      const safeImage=jpegDataUrl(sanitized);
      room.photoMetadata ||= {};
      room.photoMetadata[uid]={playerId:uid,roundId:room.roundId || room.startedAt || room.createdAt,image:safeImage,createdAt:timestamp};
      task.photoSubmittedAt=timestamp; task.targetLocation={lat:player.location.lat,lng:player.location.lng};
      task.duration=TASK_RULES.photo.seconds*1000; task.heldMs=0; task.lastProofAt=timestamp;
      task.expiresAt=timestamp+600000;
      result=true; break;
    }
    case 'failTask': { const task=player.activeTask; if (!task || task.id!==input.taskId || task.completed) throw new Error('INVALID_CHALLENGE'); failTask(player,timestamp,{penalizePhoto:true}); result=true; break; }
    case 'completeTask': {
      const task=player.activeTask;
      if(task && task.id!==input.proof?.id) throw new Error('INVALID_CHALLENGE');
      if (!task || task.id!==input.proof?.id || task.failed || task.completed || task.expiresAt<timestamp) {
        if (task && !task.completed) { failTask(player,timestamp); return {room,result:{error:'INVALID_CHALLENGE'}}; }
        throw new Error('INVALID_CHALLENGE');
      }
      if (task.kind==='cipher') {
        if (timestamp-task.createdAt<10000) { failTask(player,timestamp); return {room,result:{error:'TASK_TOO_FAST'}}; }
        if (String(input.proof.answer||'').trim().toUpperCase()!==task.answer) {
          task.attemptsLeft=Math.max(0,Number.isInteger(task.attemptsLeft)?task.attemptsLeft:3)-1;
          if(task.attemptsLeft===0) failTask(player,timestamp);
          return {room,result:{error:'WRONG_ANSWER',attemptsRemaining:task.attemptsLeft}};
        }
      } else if (task.kind==='visit' || task.kind==='scan') {
        if (!freshAccurate(player,timestamp) || distanceMeters(player.location,task.targetLocation)>task.radius) { failTask(player,timestamp); return {room,result:{error:'TASK_LOCATION_REQUIRED'}}; }
      } else if (task.kind==='proximity') {
        if (!freshAccurate(player,timestamp) || !task.arrivedAt || timestamp-task.arrivedAt>10000 || !hasNearbyHider(room,uid,player.location,timestamp,10)) { failTask(player,timestamp); return {room,result:{error:'TASK_HIDER_NOT_NEARBY'}}; }
      } else if (task.kind==='stay') {
        if (timestamp-task.lastProofAt>10000 || timestamp-task.progressSince<task.duration || !freshAccurate(player,timestamp) || distanceMeters(player.location,task.targetLocation)>10) { failTask(player,timestamp); return {room,result:{error:'TASK_NOT_HELD'}}; }
      } else throw new Error('UNKNOWN_TASK');
      if(['visit','scan'].includes(task.kind) && !task.arrivedAt) { failTask(player,timestamp); return {room,result:{error:'TASK_LOCATION_REQUIRED'}}; }
      task.completed=true; player.taskCooldownUntil=timestamp+30000;
      result=await game.completeTask(context,uid,task.kind==='cipher'?'code':task.kind); break;
    }
    case 'syncProfile': {
      const cosmeticId=input.cosmeticId;
      if(!COSMETIC_IDS.includes(cosmeticId)) throw new Error('PROFILE_INVALID');
      if(room.phase==='lobby'&&validName(input.displayName)) player.name=input.displayName.trim().replace(/\s+/g,' ');
      player.cosmeticId=cosmeticId;
      result=true; break;
    }
    case 'leaveRoom':
      if (room.players[uid]) { room.players[uid].active=false; room.players[uid].status='left'; room.players[uid].location=null; room.players[uid].locationAt=0; room.players[uid].zone={}; room.players[uid].activeTask=null; }
      if (uid===room.hostId && room.phase==='lobby') room.phase='closed';
      if (uid===room.hostId && room.phase!=='closed' && room.phase!=='lobby') {
        const successor=Object.values(room.players).filter(p=>p.active && p.status!=='left').sort((a,b)=>(a.joinedAt||0)-(b.joinedAt||0))[0];
        if(successor) { room.players[uid].isHost=false; successor.isHost=true; room.hostId=successor.id; }
      }
      if(room.photoMetadata) delete room.photoMetadata[uid];
      if(room.phase!=='closed') game.finishRoundIfNoOpposition(room,timestamp);
      result=true;
      if (Object.values(room.players).every(p=>!p.active || p.status==='left')) {
        room.phase='closed'; room.closedAt=timestamp; room.players={}; room.hostId=null; delete room.joinRequests; room.challenges={}; room.objectives={}; room.traps={}; room.decoys={}; room.itemBoxes={}; room.effects={}; room.restrictedZones={}; room.photoMetadata={}; room.roundTracks={}; room.roundResults=[]; room.roundAchievements=[]; room.eventLog=[]; room.pendingCatch=null; room.announcement=null; room.announcementForSeeker=null; room.winner=null; room.startedAt=null; room.matchEndsAt=null; room.settings.center=null; delete room.roundPhotos;
      }
      break;
    default: throw new Error('UNKNOWN_ACTION');
  }
  // Do not leak the complete mutation result (which may include raw GPS).
  if (room.phase==='finished') room.photoMetadata={};
  return {room:context.room,result:result && typeof result === 'object' && 'ok' in result ? result : Boolean(result)};
}

function resetRoomForNextRound(room,timestamp) {
  room.zonePlan=null;
  room.phase='lobby'; room.phaseEndsAt=null; room.matchEndsAt=null; room.startedAt=null; room.pendingCatch=null;
  room.announcement=null; room.announcementForSeeker=null; room.winner=null;
  room.challenges={}; room.itemBoxes={}; room.objectives={}; room.traps={}; room.decoys={}; room.effects={}; room.restrictedZones={}; room.photoMetadata={}; room.roundTracks={};
  room.roundId=crypto.randomUUID(); room.roundResults=[]; room.roundAchievements=[]; room.eventLog=[];
  room.lastPhaseTransitionAt=timestamp;
  delete room.joinRequests; delete room.roundPhotos; delete room.closedAt;
  for(const [id,player] of Object.entries(room.players||{})) {
    if(!player||player.status==='left') { delete room.players[id]; continue; }
    if(['hider','seeker'].includes(player.role)) player.previousRole=player.role;
    player.isHost=id===room.hostId; player.active=true; player.role='waiting'; player.status='waiting';
    player.coins=0; player.score=0; player.hidersFound=0; player.skillsUsed=0; player.longestStaySeconds=0; player.hiddenSeconds=0; player.stationarySince=0;
    player._stayAnchor=null; player.hiderStartedAt=0; player.rewardAt=timestamp; player.inventory=[]; player.effects={}; player.location=null; player.locationAt=0;
    player.activeTask=null; player.taskCooldownUntil=0; player.closeCallUsed=false; player.foundItems=0; player.tasksSolved=0; player.zone={violations:0}; player.zoneEvacuations={};
    player.forcedRelocation=null; player.tacticalCooldowns={}; player.timeExchangesUsed=0; player.previousStatus=null;
  }
}

export async function settlePhases(room, fetchImpl=fetch) {
  const context = {room};
  settleZoneTasks(room,Date.now());
  await settleRiskTasks(room,Date.now());
  settleTacticalDeadlines(room,Date.now());
  game.awardElapsedHiderPoints(room,Math.min(Date.now(),Number(room.matchEndsAt)||Date.now()));
  for (let i=0;i<5;i++) {
    if (!context.room.phaseEndsAt || context.room.phaseEndsAt>Date.now()) break;
    const previous=context.room.phase;
    if (!await game.advanceExpiredPhase(context,context.room)) break;
    if(previous==='hide' && context.room.phase==='playing') await spawnItemBoxes(context.room,fetchImpl,Date.now());
  }
  if(context.room.phase==='playing'&&!Object.keys(context.room.itemBoxes||{}).length&&(context.room.itemBoxSpawnAttempts||0)<4&&Date.now()-(context.room.itemBoxLastTriedAt||0)>=60000) await spawnItemBoxes(context.room,fetchImpl,Date.now());
  if(context.room.phase==='finished') context.room.photoMetadata={};
  return context.room;
}

async function spawnItemBoxes(room,fetchImpl,timestamp) {
  if(room.itemBoxSpawnInProgress) return;
  room.itemBoxSpawnInProgress=true;
  room.itemBoxSpawnAttempts=(Number(room.itemBoxSpawnAttempts)||0)+1;
  room.itemBoxLastTriedAt=timestamp;
  try {
    const points=await findSafeItemLocations(room.settings.center,Number(room.settings.radius)||500,fetchImpl);
    room.itemBoxes||={};
    for(const {location,level,layer} of points) {
      if(Object.keys(room.itemBoxes).length>=5) break;
      const id=crypto.randomUUID();
      room.itemBoxes[id]={id,location,createdAt:timestamp,collected:false,type:Math.random()<.72?'credits':'skill',...(level===undefined?{}:{level}),...(layer===undefined?{}:{layer})};
    }
    room.itemBoxSpawnInProgress=false;
    room.announcement={id:crypto.randomUUID(),type:'system',title:'SEEK PHASE LIVE',message:Object.keys(room.itemBoxes).length?`${Object.keys(room.itemBoxes).length} Signal Caches auf sicheren, öffentlich kartierten Wegen aktiviert.`:'Suche noch nach sicheren, kartierten Wegen für Signal Caches. Nächster Versuch in etwa einer Minute.',createdAt:timestamp};
  } catch {
    room.itemBoxSpawnInProgress=false;
  }
}

function recordRoundTrack(room,player,location,timestamp) {
  if(!['hide','playing'].includes(room.phase) || !player.active || !['hider','seeker'].includes(player.role) || Number(location.accuracy)>50) return;
  room.roundTracks ||= {};
  const track=room.roundTracks[player.id] ||= {points:[],distanceMeters:0};
  const last=track.points.at(-1);
  const point=[Number(location.lat),Number(location.lng)];
  if(last) {
    const elapsed=timestamp-(Number(track.lastAt)||0);
    const distance=distanceMeters({lat:last[0],lng:last[1]},{lat:point[0],lng:point[1]});
    if(elapsed<15000 && distance<12) return;
    track.distanceMeters=Math.round((Number(track.distanceMeters)||0)+distance);
    if(track.points.length>=240) track.points=track.points.filter((_,index)=>index===0 || index%2===0);
  }
  track.points.push(point);
  track.lastAt=timestamp;
}

function failTask(player,timestamp,{penalizePhoto=false,reason='Aufgabe fehlgeschlagen.'}={}) {
  const task=player.activeTask;
  if(!task || task.failed || task.completed) return;
  task.failed=true; task.failureReason=reason; player.taskCooldownUntil=timestamp+120000;
  if(penalizePhoto && task.kind==='photo' && task.photoSubmittedAt) {
    task.penaltyPoints=TASK_RULES.photo.penalty;
    player.score=(Number(player.score)||0)-task.penaltyPoints;
    task.failureReason=`Versteck vor Ablauf der drei Minuten verlassen oder Aufgabe abgebrochen: −${task.penaltyPoints} Punkte.`;
  }
}
function taskPointAvailable(room,point,timestamp) {
  if(!validPoint(point)||!validPoint(room.settings.center)||room.settings.zoneEnabled!==false&&distanceMeters(point,room.settings.center)>getPlayZone(room,timestamp).radius-10) return false;
  return !Object.values(room.restrictedZones||{}).some(zone=>zone.expiresAt>timestamp&&distanceMeters(point,zone.center)<=zone.radius+10);
}
function settleZoneTasks(room,timestamp) {
  if(room.phase!=='playing'||!room.zonePlan) return;
  const radius=getPlayZone(room,timestamp).radius;
  for(const player of Object.values(room.players||{})) {
    const task=player.activeTask;
    if(!task||task.failed||task.completed||!task.targetLocation||distanceMeters(task.targetLocation,room.settings.center)<=radius-10) continue;
    task.failed=true;task.failureReason='Die Spielzone hat dein Ziel erreicht. Aufgabe ohne Strafe beendet; du kannst sofort eine neue starten.';
    player.taskCooldownUntil=0;
  }
}
function taskGpsAt(player,timestamp) {
  return Math.min(timestamp,Number(player.locationAt)||0,Number(player.location?.measuredAt)||Number(player.locationAt)||0);
}
function freshTaskGps(player,timestamp) {
  return freshAccurate(player,timestamp) && timestamp-taskGpsAt(player,timestamp)<=10000;
}
function nearbyTaskSeeker(room,player,timestamp) {
  if(!freshTaskGps(player,timestamp)) return null;
  return Object.values(room.players||{}).filter(candidate=>candidate.active&&candidate.role==='seeker'&&freshTaskGps(candidate,timestamp)&&(candidate.effects?.frozenUntil||0)<=timestamp&&distanceMeters(player.location,candidate.location)<=TASK_RULES.closecall.radius)
    .sort((a,b)=>taskGpsAt(b,timestamp)-taskGpsAt(a,timestamp))[0]||null;
}
function finishCloseCall(player,timestamp) {
  const task=player.activeTask;
  task.completed=true; task.completedAt=timestamp;
  player.taskCooldownUntil=timestamp+(task.pointsAwarded>0?30000:120000);
  if(task.pointsAwarded>0) player.tasksSolved=(Number(player.tasksSolved)||0)+1;
}
async function settleRiskTasks(room,timestamp) {
  for(const player of Object.values(room.players||{})) {
    const task=player.activeTask;
    if(!task || task.failed || task.completed || !['photo','closecall'].includes(task.kind)) continue;
    if(!player.active || player.role!=='hider' || !['hide','playing'].includes(room.phase)) {
      if(task.kind==='closecall') finishCloseCall(player,timestamp);
      else failTask(player,timestamp,{reason:'Runde oder Teilnahme beendet.'});
      continue;
    }
    if(task.kind==='closecall') {
      const seeker=room.phase==='playing'?nearbyTaskSeeker(room,player,timestamp):null;
      if(!seeker || timestamp-task.lastProofAt>10000) { finishCloseCall(player,timestamp); continue; }
      const proofAt=Math.min(taskGpsAt(player,timestamp),taskGpsAt(seeker,timestamp),task.expiresAt);
      if(proofAt>task.lastProofAt) {
        // A different Seeker starts a new evidence interval; never count gaps or repeated samples.
        if(task.seekerId===seeker.id) task.verifiedMs+=proofAt-task.lastProofAt;
        task.lastProofAt=proofAt; task.seekerId=seeker.id;
        const points=Math.floor(task.verifiedMs/1000),delta=points-task.pointsAwarded;
        player.score=(Number(player.score)||0)+delta; task.pointsAwarded=points;
      }
      if(proofAt>=task.expiresAt || timestamp>task.expiresAt+10000) finishCloseCall(player,timestamp);
      continue;
    }
    if(timestamp>task.expiresAt) { failTask(player,timestamp,{reason:'Fotoaufgabe abgelaufen. Kein Punktabzug wegen fehlendem GPS-Nachweis.'}); continue; }
    if(!task.photoSubmittedAt) continue;
    if(!freshTaskGps(player,timestamp)) { task.heldMs=0; task.lastProofAt=null; continue; }
    const distance=distanceMeters(player.location,task.targetLocation),proofAt=taskGpsAt(player,timestamp);
    if(distance>10+Number(player.location.accuracy)) { failTask(player,timestamp,{penalizePhoto:true}); continue; }
    if(distance>10) { task.heldMs=0; task.lastProofAt=null; continue; }
    if(task.lastProofAt && proofAt>task.lastProofAt && proofAt-task.lastProofAt<=10000) task.heldMs+=proofAt-task.lastProofAt;
    else if(!task.lastProofAt || proofAt-task.lastProofAt>10000) task.heldMs=0;
    if(!task.lastProofAt || proofAt>task.lastProofAt) task.lastProofAt=proofAt;
    if(task.heldMs>=task.duration) {
      task.completed=true; task.completedAt=timestamp; player.taskCooldownUntil=timestamp+30000;
      await game.completeTask({room,timestamp},player.id,'photo');
    }
  }
}
function freshAccurate(player,timestamp) { return player.location && timestamp>=(player.locationAt||0) && timestamp-(player.locationAt||0)<=10000 && Number(player.location.accuracy)<=25; }
function freshCatchLocation(player,timestamp) { return player.location && timestamp-(player.locationAt||0)<=15000 && timestamp>=player.locationAt && Number(player.location.accuracy)<=60; }
function catchDistanceLimit() { return 8; }
function hasNearbyHider(room,seekerId,location,timestamp,radius) {
  return validPoint(location) && Object.values(room.players||{}).some(target=>target.id!==seekerId&&target.active&&target.role==='hider'&&freshAccurate(target,timestamp)&&distanceMeters(location,target.location)<=radius);
}
function settleTacticalDeadlines(room,timestamp,locationProof=null) {
  if(room.phase!=='playing') return false;
  let changed=false;
  room.restrictedZones ||= {};
  for(const player of Object.values(room.players||{})) {
    if(!player.active||player.role!=='hider') continue;
    const relocationDeadline=player.forcedRelocation&&(Number(player.forcedRelocation.deadlineAt)||Number(player.forcedRelocation.createdAt)+tacticalTuning(room.settings).relocationDeadlineSeconds*1000);
    if(relocationDeadline&&relocationDeadline<=timestamp) {
      const proof=locationProof?.playerId===player.id?locationProof.location:null;
      const completedInTime=proof&&proof.measuredAt<=relocationDeadline&&distanceMeters(proof,player.forcedRelocation.from)>=player.forcedRelocation.minimumMeters;
      if(!completedInTime) {
      if(game.applyForcedElimination(room,player.forcedRelocation.requiredBy,player.id,timestamp,'relocation')) changed=true;
      if(room.phase==='finished') return changed;
      }
    }
    for(const [zoneId,obligation] of Object.entries(player.zoneEvacuations||{})) {
      const zone=room.restrictedZones[zoneId];
      if(!zone) { delete player.zoneEvacuations[zoneId]; changed=true; continue; }
      const proof=locationProof?.playerId===player.id?locationProof.location:null;
      const provedOutsideInTime=proof&&proof.measuredAt<=obligation.deadlineAt&&distanceMeters(proof,zone.center)>zone.radius;
      if(obligation.deadlineAt<=timestamp&&provedOutsideInTime) continue; // updatePlayerLocation clears it after accepting the same proof.
      const lastKnownInside=!validPoint(player.location)||distanceMeters(player.location,zone.center)<=zone.radius;
      if(obligation.deadlineAt<=timestamp&&lastKnownInside) {
        if(game.applyForcedElimination(room,obligation.requiredBy,player.id,timestamp,'zone')) changed=true;
        if(room.phase==='finished') return changed;
        break;
      }
      if(obligation.deadlineAt<=timestamp||zone.expiresAt<=timestamp) {
        delete player.zoneEvacuations[zoneId]; zone.allowedInside=(zone.allowedInside||[]).filter(id=>id!==player.id); changed=true;
      }
    }
  }
  for(const [id,zone] of Object.entries(room.restrictedZones)) if(zone.expiresAt<=timestamp) { delete room.restrictedZones[id]; changed=true; }
  return changed;
}
function useTacticalAbility(room,player,input,timestamp) {
  if(room.phase!=='playing' || player.role!=='seeker' || !player.active) throw new Error('ABILITY_UNAVAILABLE');
  const tuning=tacticalTuning(playSettings(room,timestamp));
  const cooldowns=player.tacticalCooldowns ||= {};
  const ability=input.ability;
  if(ability==='zone') {
    if(!freshAccurate(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
    if((cooldowns.zone||0)>timestamp) throw new Error('ABILITY_COOLDOWN');
    const zoneRadius=Number(input.radius??tuning.zoneRadius);
    if(!Number.isInteger(zoneRadius)||zoneRadius<tuning.minZoneRadius||zoneRadius>tuning.maxZoneRadius) throw new Error('INVALID_ZONE_SETTINGS');
    const expiresAt=Number(room.matchEndsAt);
    if(!Number.isFinite(expiresAt)||expiresAt-timestamp<tuning.zoneEvacuationSeconds*1000) throw new Error('TASK_TIME_REQUIRED');
    const zoneCost=tuning.zoneCostFor(zoneRadius);
    const center=input.center;
    if(!validPoint(center) || !validPoint(room.settings.center) || distanceMeters(center,room.settings.center)>getPlayZone(room,timestamp).radius-zoneRadius) throw new Error('INVALID_POINT');
    room.restrictedZones=Object.fromEntries(Object.entries(room.restrictedZones||{}).filter(([,zone])=>zone.expiresAt>timestamp));
    if(Object.keys(room.restrictedZones).length>=3) throw new Error('ZONE_LIMIT');
    if((Number(player.score)||0)<zoneCost) throw new Error('POINTS_REQUIRED');
    player.score-=zoneCost;
    const id=crypto.randomUUID();
    const deadlineAt=timestamp+tuning.zoneEvacuationSeconds*1000;
    // Use the last server-accepted position to notify anyone already in the
    // circle. If it is stale, a fresh location can clear the obligation by
    // proving they are already outside.
    const inside=Object.values(room.players||{}).filter(candidate=>candidate.active&&candidate.role==='hider'&&validPoint(candidate.location)&&distanceMeters(candidate.location,center)<=zoneRadius);
    const allowedInside=inside.map(candidate=>candidate.id);
    room.restrictedZones[id]={id,center:{lat:center.lat,lng:center.lng},radius:zoneRadius,createdAt:timestamp,expiresAt,ownerId:player.id,allowedInside};
    for(const target of inside) { target.zoneEvacuations ||= {}; target.zoneEvacuations[id]={zoneId:id,deadlineAt,requiredBy:player.id}; }
    cooldowns.zone=expiresAt;
    player.skillsUsed=(Number(player.skillsUsed)||0)+1;
    room.announcement={id:crypto.randomUUID(),type:'global',title:'MAP_ZONE_LOCKED',message:`Sperrzone: Radius ${zoneRadius} m · bis zum Rundenende. Wer beim Aktivieren im Kreis steht, muss ihn innerhalb von ${Math.ceil((deadlineAt-timestamp)/1000)} Sekunden verlassen.`,createdAt:timestamp};
    return true;
  }
  if(ability==='relocate') {
    if(!freshAccurate(player,timestamp)) throw new Error('FRESH_GPS_REQUIRED');
    if((cooldowns.relocate||0)>timestamp) throw new Error('ABILITY_COOLDOWN');
    const active=Object.values(room.players||{}).filter(candidate=>candidate.active&&candidate.role==='hider');
    if(!active.length) throw new Error('NO_ACTIVE_HIDERS');
    let targets=[];
    if(input.mode==='one') {
      const target=room.players?.[input.targetId];
      if(!target || !target.active || target.role!=='hider') throw new Error('TARGET_NOT_CATCHABLE');
      targets=[target];
    } else if(input.mode==='random') {
      const choices=active.filter(candidate=>!candidate.forcedRelocation);
      if(!choices.length) throw new Error('RELOCATION_PENDING');
      targets=[choices[randomIndex(choices.length)]];
    } else if(input.mode==='all') targets=active;
    else throw new Error('INVALID_ABILITY');
    if(targets.some(target=>target.forcedRelocation)) throw new Error('RELOCATION_PENDING');
    if(targets.some(target=>!freshAccurate(target,timestamp))) throw new Error('FRESH_GPS_REQUIRED');
    const cost=tuning.relocationCost(input.mode,targets.length);
    if((Number(player.score)||0)<cost) throw new Error('POINTS_REQUIRED');
    player.score-=cost;
    for(const target of targets) target.forcedRelocation={id:crypto.randomUUID(),from:{lat:target.location.lat,lng:target.location.lng},minimumMeters:tuning.relocateDistance,createdAt:timestamp,deadlineAt:timestamp+tuning.relocationDeadlineSeconds*1000,requiredBy:player.id};
    cooldowns.relocate=timestamp+90000;
    player.skillsUsed=(Number(player.skillsUsed)||0)+1;
    room.announcement={id:crypto.randomUUID(),type:'global',title:'FORCED_RELOCATION',message:`${targets.length===1?'Ein Hider muss':'Alle ausgewählten Hider müssen'} sich mindestens ${tuning.relocateDistance} m entfernen. Frist: ${Math.ceil(tuning.relocationDeadlineSeconds/60)} Minuten. Betroffene sehen den Timer und Fortschritt auf ihrer Karte.`,createdAt:timestamp};
    return true;
  }
  if(ability==='exchangeTime') {
    const seconds=Number(input.seconds);
    if(![30,60,90].includes(seconds)) throw new Error('INVALID_ABILITY');
    if((cooldowns.exchange||0)>timestamp) throw new Error('ABILITY_COOLDOWN');
    if((Number(player.timeExchangesUsed)||0)>=3) throw new Error('EXCHANGE_LIMIT');
    const remaining=(Number(room.matchEndsAt)||0)-timestamp;
    if(remaining-seconds*1000<300000) throw new Error('MINIMUM_GAME_TIME');
    const reward=tuning.exchangeReward(seconds);
    room.matchEndsAt-=seconds*1000;
    room.phaseEndsAt=room.matchEndsAt;
    for(const zone of Object.values(room.restrictedZones||{})) zone.expiresAt=Math.min(zone.expiresAt,room.matchEndsAt);
    player.score=(Number(player.score)||0)+reward;
    player.timeExchangesUsed=(Number(player.timeExchangesUsed)||0)+1;
    cooldowns.exchange=timestamp+15000;
    player.skillsUsed=(Number(player.skillsUsed)||0)+1;
    room.announcement={id:crypto.randomUUID(),type:'private',targetId:player.id,title:'TIME_EXCHANGED',message:`${seconds} Sekunden eingetauscht · +${reward} Punkte. Noch ${3-player.timeExchangesUsed} Tausche möglich.`,createdAt:timestamp};
    return true;
  }
  throw new Error('INVALID_ABILITY');
}
function gameRandomPoint(center,radius) { const angle=Math.random()*360, distance=Math.sqrt(Math.random())*Math.max(0,radius-40); return destinationPoint(center,distance,angle); }
function sanitizeJpeg(bytes) {
  if(bytes.length<4 || bytes[0]!==0xff || bytes[1]!==0xd8) return null;
  let offset=2, hasFrame=false, hasScan=false;
  const parts=[bytes.subarray(0,2)];
  const frameMarkers=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  while(offset<bytes.length) {
    const markerStart=offset;
    if(bytes[offset]!==0xff) return null;
    while(bytes[offset]===0xff) offset++;
    if(offset>=bytes.length) return null;
    const marker=bytes[offset++];
    if(marker===0xd9) {
      if(offset!==bytes.length || !hasFrame || !hasScan) return null;
      parts.push(bytes.subarray(markerStart,offset));
      const size=parts.reduce((sum,part)=>sum+part.length,0),out=new Uint8Array(size);
      let cursor=0; for(const part of parts) { out.set(part,cursor); cursor+=part.length; }
      return out;
    }
    if(marker===0xd8 || marker===0x01 || marker>=0xd0&&marker<=0xd7) { parts.push(bytes.subarray(markerStart,offset)); continue; }
    if(marker===0x00 || offset+1>=bytes.length) return null;
    const segmentLength=(bytes[offset]<<8)|bytes[offset+1];
    if(segmentLength<2 || offset+segmentLength>bytes.length) return null;
    if(frameMarkers.has(marker)) {
      if(segmentLength<8) return null;
      const data=offset+2, height=(bytes[data+1]<<8)|bytes[data+2], width=(bytes[data+3]<<8)|bytes[data+4];
      if(!width || !height || width>320 || height>240) return null;
      hasFrame=true;
    }
    const segmentEnd=offset+segmentLength;
    // APP segments and COM can hold EXIF, XMP, IPTC, thumbnails, or location data.
    // Strip them before persisting, even if a browser encoder retained metadata.
    if(!(marker>=0xe0&&marker<=0xef)&&marker!==0xfe) parts.push(bytes.subarray(markerStart,segmentEnd));
    offset=segmentEnd;
    if(marker===0xda) {
      hasScan=true;
      const scanStart=offset;
      while(offset+1<bytes.length) {
        if(bytes[offset]!==0xff) { offset++; continue; }
        let markerOffset=offset+1;
        while(bytes[markerOffset]===0xff) markerOffset++;
        if(markerOffset>=bytes.length) return null;
        const nextMarker=bytes[markerOffset];
        if(nextMarker===0x00 || nextMarker>=0xd0&&nextMarker<=0xd7) { offset=markerOffset+1; continue; }
        break;
      }
      parts.push(bytes.subarray(scanStart,offset));
    }
  }
  return null;
}
function jpegDataUrl(bytes) {
  let binary='';
  for(const byte of bytes) binary+=String.fromCharCode(byte);
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
