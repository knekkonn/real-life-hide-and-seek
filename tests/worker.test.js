import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { applyAction, publicRoom, settlePhases } from '../worker/game.js';
import { authenticate } from '../worker/auth.js';
import { createRoomData, addPlayerToRoom, updateSettings } from '../js/game-service.js';
import { findSafeItemLocations } from '../worker/itembox.js';
import { skillTuning, tacticalTuning } from '../js/skills.js';

function playing() {
  const room=createRoomData('host','HOST'); room.code='1234';
  addPlayerToRoom(room,'guest','GUEST'); addPlayerToRoom(room,'other','OTHER');
  room.phase='playing'; room.settings.center={lat:0,lng:0}; room.matchEndsAt=Date.now()+1200000;
  for (const p of Object.values(room.players)) {p.role=p.id==='host'?'seeker':'hider';p.status=p.role;p.active=true;p.location={lat:0,lng:0,accuracy:5,measuredAt:Date.now()};p.locationAt=Date.now();}
  return room;
}
test('worker automatically centers the playzone on the host GPS when starting', async () => {
  const room=playing(),timestamp=Date.now();
  room.phase='lobby'; room.settings.center=null;
  room.players.host.location={lat:52.5,lng:13.4,accuracy:5,measuredAt:timestamp};
  room.players.host.locationAt=timestamp;
  await applyAction(room,'host',{action:'start'},timestamp);
  assert.deepEqual(room.settings.center,{lat:52.5,lng:13.4});
  assert.equal(room.phase,'countdown');
});
test('worker will not guess a playzone center when the host has no fresh GPS', async () => {
  const room=playing(),timestamp=Date.now();
  room.phase='lobby'; room.settings.center=null;
  room.players.host.location=null; room.players.host.locationAt=0;
  await assert.rejects(applyAction(room,'host',{action:'start'},timestamp),/FRESH_GPS_REQUIRED/);
  assert.equal(room.settings.center,null);
});
test('private GPS is absent from unauthorized member views, including ghost under tracker', () => {
  const room=playing();
  assert.equal(publicRoom(room,'host').players.guest.location,undefined);
  room.players.host.effects.trackerUntil=Date.now()+60000; room.players.host.effects.trackerTarget='guest';
  assert.ok(publicRoom(room,'host').players.guest.location);
  room.players.guest.effects.ghostUntil=Date.now()+45000;
  assert.equal(publicRoom(room,'host').players.guest.location,undefined);
  assert.ok(room.players.guest.location,'filter must not mutate the stored room');
  assert.throws(()=>publicRoom(room,'outsider'),/NOT_MEMBER/);
});
test('sonar returns approximate GPS and compass returns only a direction projection', () => {
  const room=playing();room.players.guest.location={lat:.001234,lng:.002345};
  room.players.host.effects.sonarUntil=Date.now()+5000;
  assert.deepEqual(publicRoom(room,'host').players.guest.location,{lat:.001,lng:.002});
  room.players.host.effects.trackerUntil=Date.now()+60000;room.players.host.effects.trackerTarget='guest';room.players.host.effects.compassUntil=Date.now()+30000;
  assert.notDeepEqual(publicRoom(room,'host').players.guest.location,room.players.guest.location);
});
test('a valid room code joins directly and enforces name and lobby rules', async () => {
  const room=createRoomData('host','HOST');
  await applyAction(room,'guest',{action:'join',name:'GUEST'});
  assert.ok(room.players.guest);
  await assert.rejects(applyAction(room,'guest',{action:'settings',patch:{radius:2000}}),/HOST_ONLY/);
  await assert.rejects(applyAction(room,'other',{action:'join',name:'GUEST'}),/NAME_IN_USE/);
  room.phase='playing';
  await assert.rejects(applyAction(room,'another',{action:'join',name:'ANOTHER'}),/LOBBY_CLOSED/);
});

test('the multiplayer Worker accepts the new one-minute hide and five-minute match minimums', async () => {
  const room=createRoomData('host','HOST'); room.code='1234';
  await applyAction(room,'host',{action:'settings',patch:{hideDuration:60,gameDuration:300}});
  assert.equal(room.settings.hideDuration,60);
  assert.equal(room.settings.gameDuration,300);
});
test('a verified in-range catch is applied immediately without target confirmation', async () => {
  const room=playing();room.settings.mode='infected';
  await applyAction(room,'host',{action:'requestCatch',targetId:'guest'});
  assert.equal(room.pendingCatch,null);
  assert.equal(room.players.guest.role,'seeker');
  assert.equal(room.players.guest.status,'infected');
  await assert.rejects(applyAction(room,'guest',{action:'respondToCatch',accepted:true,requestId:'legacy'}),/UNKNOWN_ACTION/);
  await assert.rejects(applyAction(room,'host',{action:'requestCatch',targetId:'guest'}),/TARGET_NOT_CATCHABLE/);
});

test('catch-ready proximity hints disclose only nearby Hider names to the Seeker', () => {
  const room=playing(),now=Date.now();
  room.players.host.location={lat:0,lng:0,accuracy:5,measuredAt:now}; room.players.host.locationAt=now;
  room.players.guest.location={lat:.00002,lng:0,accuracy:5,measuredAt:now}; room.players.guest.locationAt=now;
  const seekerView=publicRoom(room,'host',now);
  assert.deepEqual(seekerView.catchReadyHiders.map(p=>p.id),['guest','other']);
  assert.equal(seekerView.players.guest.location,undefined,'the proximity hint never includes GPS coordinates');
  const hiderView=publicRoom(room,'guest',now);
  assert.equal(hiderView.catchReadyHiders,undefined,'Hiders never receive private catch proximity hints');
});

test('player paths stay private until the round ends and are sanitized in the final room view', async () => {
  const room=playing(); const now=Date.now(); room.roundTracks={}; room.matchEndsAt=now+600000;
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:.001,lng:.002,accuracy:5,measuredAt:now}},now);
  assert.deepEqual(room.roundTracks.guest.points,[[.001,.002]]);
  assert.equal(publicRoom(room,'host',now).roundTracks,undefined,'live location trails are hidden from every member');
  room.roundTracks.guest.points.push([.0012,.0022]); room.roundTracks.guest.lastAt=now+5000;
  room.phase='finished';
  const result=publicRoom(room,'host',now+5000);
  assert.deepEqual(result.roundTracks.guest.points,[[.001,.002],[.0012,.0022]]);
  assert.equal(result.roundTracks.guest.lastAt,undefined,'raw sample timestamps stay private');
  room.players.guest.status='left';
  assert.throws(()=>publicRoom(room,'guest',now+5000),/NOT_MEMBER/,'players who left cannot reopen the room to read trails');
});

test('hiders earn one point for each full minute exactly once on server settlement', async () => {
  const room=playing(); const started=Date.now()-125000;
  room.matchEndsAt=Date.now()+600000;
  for(const player of [room.players.guest,room.players.other]) { player.hiderStartedAt=started; player.rewardAt=started; }
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:Date.now()}},started+125000);
  assert.equal(room.players.guest.score,2);
  assert.equal(room.players.guest.hiddenSeconds,120);
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:Date.now()}},started+125000);
  assert.equal(room.players.guest.score,2,'repeated requests cannot duplicate paid minutes');
  await applyAction(room,'host',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:Date.now()}},started+125000);
  assert.equal(room.players.host.score,0,'seekers do not receive hider survival points');
});

test('every confirmed catch rewards the seeker and writes round awards and results', async () => {
  const room=playing(); const started=Date.now()-125000;
  room.matchEndsAt=Date.now()+600000;
  for(const player of [room.players.guest,room.players.other]) { player.hiderStartedAt=started; player.rewardAt=started; }
  await applyAction(room,'host',{action:'requestCatch',targetId:'guest'});
  assert.equal(room.players.host.hidersFound,1);
  assert.ok(room.players.host.coins>=30);
  assert.ok(room.players.host.score>=50);
  await applyAction(room,'host',{action:'requestCatch',targetId:'other'});
  assert.equal(room.phase,'finished');
  assert.ok(room.roundResults.some(row=>row.id==='host'&&row.hidersFound===2));
  assert.ok(room.roundAchievements.some(award=>award.title==='Fangmaschine'&&award.playerId==='host'));
  assert.ok(room.roundResults.find(row=>row.id==='guest').score>=2);
});

test('skill prices and active ranges follow strength and playzone scale', () => {
  const compact=skillTuning('sweeper',200), wide=skillTuning('sweeper',1800);
  assert.ok(wide.price>compact.price);
  assert.ok(wide.sweepRadius>compact.sweepRadius);
  assert.ok(skillTuning('sweeper',{radius:500,gameDuration:1800}).price>skillTuning('sweeper',{radius:500,gameDuration:300}).price,'skill prices scale with match length');
  assert.ok(skillTuning('shield',1000).price>skillTuning('sprint',1000).price,'stronger effects cost more');
  assert.ok(skillTuning('freeze',1800).freezeRadius>skillTuning('freeze',200).freezeRadius,'Hider freeze range scales with the field');
});

test('Hider Frostimpuls freezes only a nearby Seeker and blocks actions until its server timer ends', async () => {
  const room=playing(),timestamp=Date.now(),duration=skillTuning('freeze',room.settings).duration;
  room.players.guest.inventory=['freeze'];
  await applyAction(room,'guest',{action:'activateSkill',skillId:'freeze'},timestamp);
  assert.equal(room.players.host.effects.freezeSource,'hider');
  assert.equal(room.players.host.effects.frozenUntil,timestamp+duration*1000);
  assert.ok(!room.players.guest.inventory.includes('freeze'));
  await assert.rejects(applyAction(room,'host',{action:'requestCatch',targetId:'guest'},timestamp+1000),/FROZEN/);
  await applyAction(room,'host',{action:'requestCatch',targetId:'guest'},timestamp+(duration+1)*1000);
  assert.equal(room.players.guest.status,'caught');
});

test('Mutprobe is a once-per-round Hider task and pays exactly one point per proven second', async () => {
  const room=playing(),timestamp=Date.now();
  const start=await applyAction(room,'guest',{action:'beginTask',kind:'closecall'},timestamp);
  const update=async(uid,at,measuredAt=at)=>applyAction(room,uid,{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt}},at);
  for(let elapsed=5000;elapsed<=60000;elapsed+=5000) {
    await update('guest',timestamp+elapsed); await update('host',timestamp+elapsed);
    await update('guest',timestamp+elapsed);
  }
  assert.equal(room.players.guest.score,60);
  assert.equal(room.players.guest.coins,0,'Mutprobe awards score, not shop currency');
  assert.equal(room.players.guest.activeTask.completed,true);
  assert.equal(room.players.guest.tasksSolved,1);
  assert.equal(publicRoom(room,'other',timestamp+60000).players.guest.activeTask,undefined);
  assert.equal(publicRoom(room,'guest',timestamp+60000).players.guest.activeTask.seekerId,undefined);
  await assert.rejects(applyAction(room,'guest',{action:'beginTask',kind:'closecall'},timestamp+91000),/TASK_ALREADY_USED/);
  await assert.rejects(applyAction(room,'guest',{action:'completeTask',proof:{id:start.result.id}},timestamp+92000),/INVALID_CHALLENGE/);
  room.phase='finished'; await applyAction(room,'host',{action:'newRound'},timestamp+93000);
  assert.equal(room.players.guest.closeCallUsed,false,'only a new round restores the attempt');
});

test('Mutprobe ends on leaving 15 m or missing GPS without retroactive or duplicated points', async () => {
  for(const leave of [true,false]) {
    const room=playing(),timestamp=Date.now();
    await applyAction(room,'guest',{action:'beginTask',kind:'closecall'},timestamp);
    for(const uid of ['host','guest']) await applyAction(room,uid,{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:timestamp+5000}},timestamp+5000);
    assert.equal(room.players.guest.score,5);
    if(leave) await applyAction(room,'host',{action:'updatePlayerLocation',location:{lat:.00015,lng:0,accuracy:5,measuredAt:timestamp+6000}},timestamp+6000);
    else await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:timestamp+16000}},timestamp+16000);
    assert.equal(room.players.guest.activeTask.completed,true);
    assert.equal(room.players.guest.score,5);
    await assert.rejects(applyAction(room,'guest',{action:'beginTask',kind:'closecall'},timestamp+140000),/TASK_ALREADY_USED/);
  }
});

test('Mutprobe rejects Seekers, hiding phase, out-of-range and frozen opponents', async () => {
  const room=playing(),timestamp=Date.now();
  await assert.rejects(applyAction(room,'host',{action:'beginTask',kind:'closecall'},timestamp),/TASK_UNAVAILABLE/);
  room.phase='hide';
  await assert.rejects(applyAction(room,'guest',{action:'beginTask',kind:'closecall'},timestamp),/TASK_UNAVAILABLE/);
  room.phase='playing'; room.players.host.location.lat=.00015;
  await assert.rejects(applyAction(room,'guest',{action:'beginTask',kind:'closecall'},timestamp),/SEEKER_NOT_NEARBY/);
  room.players.host.location.lat=0; room.players.host.effects.frozenUntil=timestamp+5000;
  await assert.rejects(applyAction(room,'guest',{action:'beginTask',kind:'closecall'},timestamp),/SEEKER_NOT_NEARBY/);
  assert.equal(room.players.guest.closeCallUsed,undefined,'invalid attempts do not consume the task');
});

test('Seeker map restrictions spend dynamic points, display to Hiders, and block entry', async () => {
  const room=playing(),timestamp=Date.now(),tuning=tacticalTuning(room.settings); room.players.host.score=100;
  const center={lat:0,lng:.002};
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'zone',center},timestamp);
  assert.equal(room.players.host.score,100-tuning.zoneCost);
  assert.equal(Object.keys(publicRoom(room,'guest',timestamp).restrictedZones).length,1);
  await assert.rejects(applyAction(room,'guest',{action:'updatePlayerLocation',location:{...center,accuracy:5,measuredAt:timestamp+1000}},timestamp+1000),/RESTRICTED_AREA/);
  assert.equal(room.players.guest.location.lng,0,'a rejected entry never overwrites the last accepted GPS point');
});

test('Sperrzonen persist to round end, show a private evacuation deadline and charge by size', async () => {
  const room=playing(),timestamp=Date.now(),tuning=tacticalTuning(room.settings); room.players.host.score=200;
  room.players.other.location={lat:0,lng:.004,accuracy:5,measuredAt:timestamp}; room.players.other.locationAt=timestamp;
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'zone',center:{lat:0,lng:.001},radius:120,duration:90},timestamp);
  const zone=Object.values(room.restrictedZones)[0];
  assert.equal(zone.radius,120); assert.equal(zone.expiresAt,room.matchEndsAt);
  assert.equal(room.players.guest.zoneEvacuations[zone.id].deadlineAt,timestamp+45000);
  assert.equal(room.players.other.zoneEvacuations,undefined);
  assert.equal(publicRoom(room,'guest',timestamp).players.guest.zoneEvacuations[zone.id].deadlineAt,timestamp+45000);
  assert.equal(publicRoom(room,'other',timestamp).players.guest.zoneEvacuations,undefined);
  assert.equal(room.players.host.score,200-tuning.zoneCostFor(120,90));
  const later=timestamp+91_000;
  await applyAction(room,'host',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:later-1}},later-1);
  await assert.rejects(applyAction(room,'host',{action:'useTacticalAbility',ability:'zone',center:{lat:0,lng:.001},radius:tuning.maxZoneRadius+1,duration:90},later),/ABILITY_COOLDOWN/);
  room.players.host.tacticalCooldowns={};
  await assert.rejects(applyAction(room,'host',{action:'useTacticalAbility',ability:'zone',center:{lat:0,lng:.001},radius:tuning.maxZoneRadius+1},later),/INVALID_ZONE_SETTINGS/);
});

test('a Hider who misses the restricted-zone evacuation deadline is eliminated and rewards its Seeker', async () => {
  const room=playing(),timestamp=Date.now(); room.players.host.score=150;
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'zone',center:{lat:0,lng:.001},radius:120,duration:90},timestamp);
  const zone=Object.values(room.restrictedZones)[0];
  zone.allowedInside=['guest']; room.players.guest.zoneEvacuations[zone.id].deadlineAt=timestamp+1000;
  const before=room.players.host.score;
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0,lng:.001,accuracy:5,measuredAt:timestamp+1001}},timestamp+1001);
  assert.equal(room.players.guest.active,false); assert.equal(room.players.guest.status,'caught');
  assert.ok(room.players.host.score>before); assert.equal(room.players.host.hidersFound,1);
});

test('a timely GPS sample received just after the zone deadline clears the evacuation instead of eliminating the Hider', async () => {
  const room=playing(),timestamp=Date.now(); room.players.host.score=150;
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'zone',center:{lat:0,lng:.001},radius:120,duration:90},timestamp);
  const zone=Object.values(room.restrictedZones)[0]; zone.allowedInside=['guest']; room.players.guest.zoneEvacuations[zone.id].deadlineAt=timestamp+1000;
  const receivedAt=timestamp+2000;
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0,lng:.003,accuracy:5,measuredAt:timestamp+900}},receivedAt);
  assert.equal(room.players.guest.active,true);
  assert.equal(room.players.guest.zoneEvacuations[zone.id],undefined);
  assert.equal(room.players.host.hidersFound,0);
});

test('a zone evacuation still fails after delayed settlement even when the circle itself has expired', async () => {
  const room=playing(),timestamp=Date.now(); room.players.host.score=150;
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'zone',center:{lat:0,lng:.001},radius:120,duration:90},timestamp);
  const zone=Object.values(room.restrictedZones)[0]; zone.allowedInside=['guest'];
  room.players.guest.zoneEvacuations[zone.id].deadlineAt=timestamp+1000;
  zone.expiresAt=timestamp+1500;
  const before=room.players.host.score;
  await applyAction(room,'host',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:timestamp+5000}},timestamp+5000);
  assert.equal(room.players.guest.active,false);
  assert.ok(room.players.host.score>before);
  assert.equal(room.players.host.hidersFound,1);
});

test('a Hider already inside a restricted circle can leave but cannot later re-enter', async () => {
  const room=playing(),timestamp=Date.now(),center={lat:0,lng:.001}; room.players.host.score=100;
  room.players.guest.location={...center,accuracy:5,measuredAt:timestamp}; room.players.guest.locationAt=timestamp;
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'zone',center},timestamp);
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0,lng:.0011,accuracy:5,measuredAt:timestamp+1000}},timestamp+1000);
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0,lng:.003,accuracy:5,measuredAt:timestamp+2000}},timestamp+2000);
  await assert.rejects(applyAction(room,'guest',{action:'updatePlayerLocation',location:{...center,accuracy:5,measuredAt:timestamp+3000}},timestamp+3000),/RESTRICTED_AREA/);
});

test('Seeker relocation requires each target to move the map-scaled minimum distance', async () => {
  const room=playing(),timestamp=Date.now(),tuning=tacticalTuning(room.settings); room.players.host.score=150;
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'relocate',mode:'one',targetId:'guest'},timestamp);
  assert.equal(room.players.host.score,150-tuning.relocationCost('one'));
  assert.equal(room.players.guest.forcedRelocation.minimumMeters,tuning.relocateDistance);
  assert.equal(publicRoom(room,'guest',timestamp).players.guest.forcedRelocation.minimumMeters,tuning.relocateDistance);
  assert.equal(publicRoom(room,'host',timestamp).players.guest.forcedRelocation,undefined,'the old position is private to its owner');
  await assert.rejects(applyAction(room,'guest',{action:'beginTask',kind:'cipher'},timestamp+1000),/RELOCATION_REQUIRED/);
  const moved={lat:.0008,lng:0,accuracy:5,measuredAt:timestamp+2000};
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:moved},timestamp+2000);
  assert.equal(room.players.guest.forcedRelocation,null,'the server clears the requirement after the minimum distance');
});

test('a Hider who misses a relocation deadline is eliminated and rewards the commanding Seeker', async () => {
  const room=playing(),timestamp=Date.now(); room.players.host.score=150;
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'relocate',mode:'one',targetId:'guest'},timestamp);
  room.players.guest.forcedRelocation.deadlineAt=timestamp+1000;
  const before=room.players.host.score;
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:timestamp+1001}},timestamp+1001);
  assert.equal(room.players.guest.active,false); assert.equal(room.players.guest.status,'caught');
  assert.ok(room.players.host.score>before); assert.equal(room.players.host.hidersFound,1);
});

test('a relocation completed by a pre-deadline GPS sample is accepted if network delivery is slightly late', async () => {
  const room=playing(),timestamp=Date.now(); room.players.host.score=150;
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'relocate',mode:'one',targetId:'guest'},timestamp);
  room.players.guest.forcedRelocation.deadlineAt=timestamp+1000;
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:.0008,lng:0,accuracy:5,measuredAt:timestamp+900}},timestamp+2000);
  assert.equal(room.players.guest.active,true);
  assert.equal(room.players.guest.forcedRelocation,null);
  assert.equal(room.players.host.hidersFound,0);
});

test('Seeker relocation supports a random target and the whole Hider team', async () => {
  const randomRoom=playing(),randomTimestamp=Math.max(Date.now(),randomRoom.players.host.locationAt); randomRoom.players.host.score=200;
  await applyAction(randomRoom,'host',{action:'useTacticalAbility',ability:'relocate',mode:'random'},randomTimestamp);
  assert.equal(Object.values(randomRoom.players).filter(player=>player.forcedRelocation).length,1);
  const teamRoom=playing(),teamTimestamp=Math.max(Date.now(),teamRoom.players.host.locationAt); teamRoom.players.host.score=250;
  const teamCost=tacticalTuning(teamRoom.settings).relocationCost('all',2);
  await applyAction(teamRoom,'host',{action:'useTacticalAbility',ability:'relocate',mode:'all'},teamTimestamp);
  assert.equal(Object.values(teamRoom.players).filter(player=>player.forcedRelocation).length,2);
  assert.equal(teamRoom.players.host.score,250-teamCost);
});

test('Seeker can trade time for points without shortening a round below five minutes', async () => {
  const room=playing(),timestamp=Date.now(),tuning=tacticalTuning(room.settings); room.matchEndsAt=timestamp+600000;
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'exchangeTime',seconds:60},timestamp);
  assert.equal(room.matchEndsAt,timestamp+540000);
  assert.equal(room.players.host.score,tuning.exchangeReward(60));
  await assert.rejects(applyAction(room,'host',{action:'useTacticalAbility',ability:'exchangeTime',seconds:30},timestamp+1000),/ABILITY_COOLDOWN/);
  room.players.host.tacticalCooldowns.exchange=timestamp;
  room.matchEndsAt=timestamp+320000;
  await assert.rejects(applyAction(room,'host',{action:'useTacticalAbility',ability:'exchangeTime',seconds:30},timestamp+16000),/MINIMUM_GAME_TIME/);
  assert.equal(room.matchEndsAt,timestamp+320000,'a rejected exchange leaves the deadline intact');
});
test('catch enforces a hard maximum distance of eight meters', async () => {
  const room=playing();
  room.players.guest.location={lat:.0002,lng:0,accuracy:5,measuredAt:Date.now()};room.players.guest.locationAt=Date.now();
  await assert.rejects(applyAction(room,'host',{action:'requestCatch',targetId:'guest'}),/CATCH_RANGE_REQUIRED/);
  assert.equal(room.players.guest.role,'hider');
  const close=playing();close.settings.mode='infected';close.players.guest.location={lat:.00004,lng:0,accuracy:5,measuredAt:Date.now()};close.players.guest.locationAt=Date.now();
  await applyAction(close,'host',{action:'requestCatch',targetId:'guest'});
  assert.equal(close.players.guest.role,'seeker','a GPS distance within the accuracy-adjusted range is accepted');
  const laptop=playing();laptop.settings.mode='infected';laptop.players.host.location={lat:0,lng:0,accuracy:45,measuredAt:Date.now()};laptop.players.host.locationAt=Date.now();laptop.players.guest.location={lat:.00006,lng:0,accuracy:50,measuredAt:Date.now()};laptop.players.guest.locationAt=Date.now();
  await applyAction(laptop,'host',{action:'requestCatch',targetId:'guest'});
  assert.equal(laptop.players.guest.role,'seeker','moderate laptop GPS drift is supported when the players are close');
  const outside=playing();outside.players.guest.location={lat:.0004,lng:0,accuracy:5,measuredAt:Date.now()};outside.players.guest.locationAt=Date.now();
  await assert.rejects(applyAction(outside,'host',{action:'requestCatch',targetId:'guest'}),/CATCH_RANGE_REQUIRED/);
  const justOutside=playing();justOutside.players.guest.location={lat:.00008,lng:0,accuracy:5,measuredAt:Date.now()};justOutside.players.guest.locationAt=Date.now();
  await assert.rejects(applyAction(justOutside,'host',{action:'requestCatch',targetId:'guest'}),/CATCH_RANGE_REQUIRED/,'the catch limit stays below 9 m even when GPS accuracy is poor');
  room.players.guest.location={lat:0,lng:0,accuracy:70,measuredAt:Date.now()};room.players.guest.locationAt=Date.now();
  await assert.rejects(applyAction(room,'host',{action:'requestCatch',targetId:'guest'}),/FRESH_GPS_REQUIRED/);
});

test('item boxes are selected only from mapped public footways and are disabled when OSM is unavailable', async () => {
  const response={elements:[
    {type:'way',tags:{highway:'footway',foot:'yes'},geometry:Array.from({length:11},(_,i)=>({lat:0,lon:-.001+i*.0002}))},
    {type:'way',tags:{building:'yes'},geometry:[{lat:-.0001,lon:-.0001},{lat:-.0001,lon:.0001},{lat:.0001,lon:.0001},{lat:.0001,lon:-.0001},{lat:-.0001,lon:-.0001}]}
  ]};
  const fetchImpl=async()=>new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});
  const points=await findSafeItemLocations({lat:0,lng:0},500,fetchImpl);
  assert.ok(points.length>0);
  assert.ok(points.every(point=>Math.abs(point.location.lat)<1e-8),'cache should remain on the mapped footway');
  assert.deepEqual(await findSafeItemLocations({lat:0,lng:0},500,async()=>new Response('',{status:503})),[]);
});
test('public map lookups use a rounded playzone center and retry the approved second endpoint', async () => {
  const urls=[],queries=[];
  const fetchImpl=async(url,options)=>{urls.push(url);queries.push(new URLSearchParams(options.body).get('data'));return urls.length===1?new Response('',{status:503}):new Response(JSON.stringify({elements:[]}));};
  await findSafeItemLocations({lat:52.123456,lng:13.654321},500,fetchImpl);
  assert.deepEqual(urls,['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter']);
  assert.match(queries[0],/around:620,52\.123,13\.654/);
  assert.doesNotMatch(queries[0],/52\.123456|13\.654321/);
});
test('protected-area multipolygon relations block cache points even when boundary ways are split', async () => {
  const ring=[[ -.0001,-.0001],[-.0001,.0001],[.0001,.0001],[.0001,-.0001],[-.0001,-.0001]];
  const relation={type:'relation',tags:{boundary:'protected_area'},members:ring.slice(1).map((point,i)=>({type:'way',role:'outer',geometry:[{lat:ring[i][0],lon:ring[i][1]},{lat:point[0],lon:point[1]}]}))};
  const path={type:'way',tags:{highway:'footway',foot:'yes'},geometry:Array.from({length:11},(_,i)=>({lat:0,lon:-.001+i*.0002}))};
  const fetchImpl=async()=>new Response(JSON.stringify({elements:[path,relation]}),{headers:{'content-type':'application/json'}});
  const points=await findSafeItemLocations({lat:0,lng:0},500,fetchImpl);
  assert.ok(points.length>0);
  assert.ok(points.every(({location})=>Math.abs(location.lng)>.0001),'all generated points stay outside the protected polygon');
});
test('transition into the live phase announces and stores only OSM-checked item boxes', async () => {
  const room=playing();room.phase='hide';room.phaseEndsAt=Date.now()-1;
  const fetchImpl=async()=>new Response(JSON.stringify({elements:[{type:'way',tags:{highway:'footway',foot:'designated',level:'1'},geometry:Array.from({length:11},(_,i)=>({lat:0,lon:-.001+i*.0002}))}]}),{headers:{'content-type':'application/json'}});
  const result=await settlePhases(room,fetchImpl);
  assert.equal(result.phase,'playing');
  assert.ok(Object.keys(result.itemBoxes).length>0);
  assert.ok(Object.values(result.itemBoxes).every(box=>box.level===1));
  assert.match(result.announcement.message,/öffentlich kartierten Wegen/);
});
test('forged reward submissions cannot award currency', async () => {
  const room=playing();const before=room.players.guest.coins;
  await assert.rejects(applyAction(room,'guest',{action:'completeTask',kind:'code',proof:{id:'forged',answer:42}}),/INVALID_CHALLENGE/);
  assert.equal(room.players.guest.coins,before);
});
test('server-issued casual logic code is unique, private, rate-limited and redeemable once', async () => {
  const room=playing(); const timestamp=Date.now();
  const {result}=await applyAction(room,'guest',{action:'beginTask',kind:'cipher'},timestamp);
  const challenge=room.players.guest.activeTask;
  assert.match(result.prompt,/3-stelligen Code/);
  assert.match(result.prompt,/richtig platziert/);
  assert.doesNotMatch(result.prompt,/Vigenère|KRYPTANALYSE/);
  const clues=[...result.prompt.matchAll(/([0-9]{3}) → ([0-3]) richtig platziert · ([0-3]) an anderer Stelle/g)].map(match=>({guess:match[1],exact:Number(match[2]),misplaced:Number(match[3])}));
  assert.ok(clues.length>=5);
  const codes=[];for(let a=0;a<10;a++)for(let b=0;b<10;b++)for(let c=0;c<10;c++)if(a!==b&&a!==c&&b!==c)codes.push(`${a}${b}${c}`);
  const feedback=(code,guess)=>{let exact=0,present=0;for(let i=0;i<3;i++){if(code[i]===guess[i])exact++;if(code.includes(guess[i]))present++;}return {exact,misplaced:present-exact};};
  const solutions=codes.filter(code=>clues.every(clue=>{const score=feedback(code,clue.guess);return score.exact===clue.exact&&score.misplaced===clue.misplaced;}));
  assert.deepEqual(solutions,[challenge.answer],'the casual clues identify exactly the private server code');
  assert.equal(result.expiresAt-timestamp,150000);
  assert.equal(publicRoom(room,'guest',timestamp).players.guest.activeTask.answer,undefined);
  assert.equal(publicRoom(room,'host',timestamp).players.guest.activeTask,undefined);
  const tooFast=await applyAction(room,'guest',{action:'completeTask',proof:{id:result.id,answer:challenge.answer}},timestamp+1000);
  assert.equal(tooFast.result.error,'TASK_TOO_FAST');
  assert.equal(room.players.guest.taskCooldownUntil,timestamp+121000);
  assert.equal(room.players.guest.coins,0);

  const successRoom=playing();
  const started=await applyAction(successRoom,'guest',{action:'beginTask',kind:'cipher'},timestamp);
  const answer=successRoom.players.guest.activeTask.answer;
  const reward=await applyAction(successRoom,'guest',{action:'completeTask',proof:{id:started.result.id,answer}},timestamp+11000);
  assert.equal(reward.result,true);
  assert.equal(successRoom.players.guest.coins,25);
  await assert.rejects(applyAction(successRoom,'guest',{action:'completeTask',proof:{id:started.result.id,answer}},timestamp+32000),/INVALID_CHALLENGE/);
});

test('the code task allows three server-checked guesses before applying its cooldown', async () => {
  const room=playing(),timestamp=Date.now();
  const {result:challenge}=await applyAction(room,'guest',{action:'beginTask',kind:'cipher'},timestamp);
  assert.equal(room.players.guest.activeTask.attemptsLeft,3);
  for(let attempt=1;attempt<=3;attempt++) {
    const at=timestamp+10000+attempt*1000;
    const rejected=await applyAction(room,'guest',{action:'completeTask',proof:{id:challenge.id,answer:'000'}},at);
    const attemptsRemaining=3-attempt;
    assert.equal(rejected.result.error,'WRONG_ANSWER');
    assert.equal(rejected.result.attemptsRemaining,attemptsRemaining);
    assert.equal(room.players.guest.activeTask.failed,attempt===3);
    assert.equal(room.players.guest.taskCooldownUntil||0,attempt===3?at+120000:0);
  }
});

test('a correct code still succeeds after one wrong guess', async () => {
  const room=playing(),timestamp=Date.now();
  const {result:challenge}=await applyAction(room,'guest',{action:'beginTask',kind:'cipher'},timestamp);
  const wrong=await applyAction(room,'guest',{action:'completeTask',proof:{id:challenge.id,answer:'000'}},timestamp+11000);
  assert.equal(wrong.result.attemptsRemaining,2);
  const answer=room.players.guest.activeTask.answer;
  const solved=await applyAction(room,'guest',{action:'completeTask',proof:{id:challenge.id,answer}},timestamp+12000);
  assert.equal(solved.result,true);
  assert.equal(room.players.guest.coins,25);
});

test('all GPS task thresholds stay at or below ten meters', async () => {
  const room=playing(),timestamp=Date.now();
  room.objectives={one:{id:'one',location:{lat:.001,lng:0}}};
  const visit=await applyAction(room,'guest',{action:'beginTask',kind:'visit'},timestamp);
  assert.equal(room.players.guest.activeTask.radius,10);
  const hold=await applyAction(room,'other',{action:'beginTask',kind:'stay'},timestamp);
  assert.equal(room.players.other.activeTask.duration,60000);
  const moved=await applyAction(room,'other',{action:'updatePlayerLocation',location:{lat:.0001,lng:0,accuracy:5,measuredAt:timestamp+1000}},timestamp+1000);
  assert.equal(room.players.other.activeTask.failed,true,'moving more than 10 m fails the hold task');
  assert.ok(visit.result.id&&hold.result.id&&moved.result);
  const compact=createRoomData('host','HOST');
  updateSettings(compact,'host',{radius:25});
  assert.equal(compact.settings.radius,50,'the smallest supported zone is 50 m');
  updateSettings(compact,'host',{radius:500});
  updateSettings(compact,'host',{radius:50});
  assert.equal(skillTuning('decoy',50).zoneRadius,50);
});

test('seeker tasks are role-specific and server-check cache or hider proximity', async () => {
  const room=playing(),timestamp=Date.now();
  room.itemBoxes={box1:{id:'box1',location:{lat:0,lng:0},collected:false},box2:{id:'box2',location:{lat:.00002,lng:0},collected:false}};
  await assert.rejects(applyAction(room,'guest',{action:'beginTask',kind:'scan'},timestamp),/TASK_UNAVAILABLE/);
  const scan=await applyAction(room,'host',{action:'beginTask',kind:'scan'},timestamp);
  assert.match(scan.result.prompt,/Signal Cache scannen/);
  assert.ok(room.players.host.activeTask.targetBoxId==='box1'||room.players.host.activeTask.targetBoxId==='box2');
  await applyAction(room,'host',{action:'updatePlayerLocation',location:{lat:room.players.host.activeTask.targetLocation.lat,lng:room.players.host.activeTask.targetLocation.lng,accuracy:5,measuredAt:timestamp+1000}},timestamp+1000);
  const scanned=await applyAction(room,'host',{action:'completeTask',proof:{id:scan.result.id}},timestamp+2000);
  assert.equal(scanned.result,true);
  assert.equal(room.players.host.coins,25);

  // The first GPS fixes in playing() are now stale. Refresh both players so
  // proximity can be proven from current server-side measurements.
  await applyAction(room,'host',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:timestamp+40000}},timestamp+40000);
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:timestamp+40000}},timestamp+40000);
  // game-service stamps locationAt with wall clock time; align this synthetic
  // test timeline with the timestamps passed to applyAction.
  room.players.host.locationAt=room.players.guest.locationAt=timestamp+40000;
  const search=await applyAction(room,'host',{action:'beginTask',kind:'proximity'},timestamp+40000);
  assert.match(search.result.prompt,/10 m/);
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:timestamp+41000}},timestamp+41000);
  room.players.guest.locationAt=timestamp+41000;
  await applyAction(room,'host',{action:'updatePlayerLocation',location:{lat:0,lng:0,accuracy:5,measuredAt:timestamp+41000}},timestamp+41000);
  room.players.host.locationAt=timestamp+41000;
  const found=await applyAction(room,'host',{action:'completeTask',proof:{id:search.result.id}},timestamp+42000);
  assert.equal(found.result,true);
  assert.equal(room.players.host.tasksSolved,2);
});

test('visit tasks select private in-zone targets and movement failures trigger cooldown', async () => {
  const room=playing(); const timestamp=Date.now();
  room.objectives={one:{id:'one',location:{lat:0.001,lng:0}}};
  assert.equal(publicRoom(room,'guest',timestamp).objectives,undefined,'all objective coordinates stay private until assigned');
  const {result}=await applyAction(room,'guest',{action:'beginTask',kind:'visit'},timestamp);
  assert.deepEqual(result.targetLocation,{lat:0.001,lng:0},'the target is returned only to the requesting player');
  const guestView=publicRoom(room,'guest',timestamp);
  assert.deepEqual(guestView.players.guest.activeTask.targetLocation,{lat:0.001,lng:0});
  assert.equal(publicRoom(room,'host',timestamp).players.guest.activeTask,undefined);
  const failed=await applyAction(room,'guest',{action:'completeTask',proof:{id:result.id}},timestamp+1000);
  assert.equal(failed.result.error,'TASK_LOCATION_REQUIRED');
  assert.equal(room.players.guest.taskCooldownUntil,timestamp+121000);
});

test('visit target is completed automatically by a fresh GPS arrival without a click', async () => {
  const room=playing(); const timestamp=Date.now(); room.objectives={one:{id:'one',location:{lat:.001,lng:0}}};
  const {result:challenge}=await applyAction(room,'guest',{action:'beginTask',kind:'visit'},timestamp);
  const before=room.players.guest.coins;
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:.001,lng:0,accuracy:5,measuredAt:timestamp+1000}},timestamp+1000);
  assert.equal(room.players.guest.activeTask.completed,true);
  assert.equal(room.players.guest.activeTask.id,challenge.id);
  assert.equal(room.players.guest.coins,before+30);
  assert.equal(room.players.guest.tasksSolved,1);
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:.001,lng:0,accuracy:5,measuredAt:timestamp+2000}},timestamp+2000);
  assert.equal(room.players.guest.coins,before+30,'repeated GPS updates cannot duplicate the reward');
});

test('stay tasks fail when the player leaves the registered hiding point', async () => {
  const room=playing(); const timestamp=Date.now();
  const {result}=await applyAction(room,'guest',{action:'beginTask',kind:'stay'},timestamp);
  const moved=await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:0.001,lng:0,accuracy:5,measuredAt:timestamp+1000}},timestamp+1000);
  assert.ok(moved.result);
  assert.equal(room.players.guest.activeTask.failed,true);
  assert.equal(room.players.guest.taskCooldownUntil,timestamp+121000);
  assert.equal(room.players.guest.activeTask.id,result.id,'the failed attempt remains recorded until the next attempt');
});

test('round photo task only shares sanitized JPEG with seekers and erases it on round end', async () => {
  const room=playing(); const timestamp=Date.now();
  const {result}=await applyAction(room,'guest',{action:'beginTask',kind:'photo'},timestamp);
  const jpeg=Uint8Array.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x00,0xf0,0x01,0x40,0x03,0x01,0x11,0x00,0x02,0x11,0x00,0x03,0x11,0x00,0xff,0xda,0x00,0x0c,0x03,0x01,0x00,0x02,0x11,0x03,0x11,0x00,0x3f,0x00,...new Array(120).fill(0x11),0xff,0xd9]);
  const image='data:image/jpeg;base64,'+Buffer.from(jpeg).toString('base64');
  await applyAction(room,'guest',{action:'submitPhoto',taskId:result.id,image},timestamp+1000);
  assert.equal(Object.keys(room.photoMetadata).length,1);
  assert.equal(publicRoom(room,'host',timestamp+1000).roundPhotos[0].image,undefined,'room polling returns photo metadata only');
  assert.equal(publicRoom(room,'guest',timestamp+1000).roundPhotos,undefined,'hider photos are not echoed to hiders');
  await assert.rejects(applyAction(room,'guest',{action:'beginTask',kind:'photo'},timestamp+32000),/TASK_ALREADY_ACTIVE/);
  assert.equal(room.players.guest.activeTask.completed,false,'upload alone never pays a reward');
  await assert.rejects(applyAction(room,'guest',{action:'submitPhoto',taskId:result.id,image},timestamp+2000),/PHOTO_ALREADY_SUBMITTED/);
  room.phase='finished';
  const finished=await applyAction(room,'host',{action:'advanceExpiredPhase'});
  assert.deepEqual(finished.room.photoMetadata,{});
  assert.equal(publicRoom(finished.room,'host',timestamp+33000).roundPhotos,undefined);

  const exifRoom=playing();const exifStart=await applyAction(exifRoom,'guest',{action:'beginTask',kind:'photo'},timestamp);
  const exif=new Uint8Array([...jpeg.slice(0,2),0xff,0xe1,0,8,0x45,0x78,0x69,0x66,0,0,0xff,0xed,0,5,1,2,3,0xff,0xfe,0,5,4,5,6,...jpeg.slice(2)]);
  const stripped=await applyAction(exifRoom,'guest',{action:'submitPhoto',taskId:exifStart.result.id,image:'data:image/jpeg;base64,'+Buffer.from(exif).toString('base64')},timestamp+1000);
  assert.equal(stripped.result,true,'the server strips metadata instead of failing an otherwise valid photo');
  const stored=Uint8Array.from(atob(exifRoom.photoMetadata.guest.image.split(',')[1]),char=>char.charCodeAt(0));
  assert.equal(stored.some((byte,index)=>byte===0xff&&([0xe1,0xed,0xfe].includes(stored[index+1]))),false,'EXIF, IPTC, and comment segments are removed before persistence');
});

test('photo download endpoint returns bytes only to active seekers in the live round',async()=>{
  const env={DB:d1(),ALLOWED_ORIGIN:'https://knekkonn.github.io'};
  const room=playing();room.code='1234';room.roundId='round-1';room.photoMetadata={guest:{playerId:'guest',roundId:'round-1',image:'data:image/jpeg;base64,/9j/AA==',createdAt:Date.now()}};
  await env.DB.prepare('INSERT INTO rooms(code,revision,state,expires_at) VALUES (?,0,?,?)').bind('1234',JSON.stringify(room),Date.now()+60000).run();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>new Response(JSON.stringify({users:[{localId:JSON.parse(options.body).idToken}]}),{status:200});
  try {
    const request=uid=>new Request('https://api.test/rooms/1234/photos/guest',{headers:{Authorization:`Bearer ${uid}`,Origin:env.ALLOWED_ORIGIN}});
    const allowed=await worker.fetch(request('host'),env);
    assert.equal(allowed.status,200);assert.equal(allowed.headers.get('Content-Type'),'image/jpeg');
    assert.deepEqual([...new Uint8Array(await allowed.arrayBuffer())],[0xff,0xd8,0xff,0x00]);
    assert.equal((await worker.fetch(request('guest'),env)).status,403,'hiders cannot download the photo endpoint');
    const state=await env.DB.prepare('SELECT state FROM rooms WHERE code=?').bind('1234').first();
    const closed=JSON.parse(state.state);closed.phase='finished';
    await env.DB.prepare('UPDATE rooms SET state=? WHERE code=?').bind(JSON.stringify(closed),'1234').run();
    assert.equal((await worker.fetch(request('host'),env)).status,403,'photos stop being available once the round ends');
  } finally {globalThis.fetch=originalFetch;}
});

test('new round resets player locations and tracks and last departure clears all room player data', async () => {
  const room=playing(); room.phase='finished';room.players.guest.location={lat:1,lng:1};room.photoMetadata={guest:{image:'private'}};room.roundTracks={guest:{points:[[1,1],[1.1,1.1]]}};
  await applyAction(room,'host',{action:'newRound'});
  assert.equal(room.phase,'lobby');assert.equal(room.players.guest.role,'waiting');assert.equal(room.players.guest.location,null);assert.deepEqual(room.photoMetadata,{});assert.deepEqual(room.roundTracks,{});
  room.restrictedZones={test:{id:'test',center:{lat:0,lng:0},radius:30,expiresAt:Date.now()+60000}};
  await applyAction(room,'host',{action:'leaveRoom'});
  assert.equal(Object.keys(room.players).length,3,'remaining player data is retained until the room is empty');
  await applyAction(room,'guest',{action:'leaveRoom'});
  assert.equal(Object.keys(room.players).length,3,'player records are cleared only after every player has left');
  await applyAction(room,'other',{action:'leaveRoom'});
  assert.equal(room.phase,'closed');assert.deepEqual(room.players,{});assert.deepEqual(room.photoMetadata,{});assert.deepEqual(room.roundTracks,{});assert.deepEqual(room.restrictedZones,{});assert.equal(room.hostId,null);assert.equal(room.settings.center,null);
});
test('new round keeps caught players in the room and removes only players who left',async()=>{
  const room=playing();room.phase='finished';
  room.players.guest.active=false;room.players.guest.status='caught';room.players.guest.role='spectator';
  room.players.other.active=false;room.players.other.status='left';
  await applyAction(room,'host',{action:'newRound'});
  assert.deepEqual(Object.keys(room.players).sort(),['guest','host']);
  assert.equal(room.players.guest.active,true);assert.equal(room.players.guest.status,'waiting');
  assert.equal(room.players.guest.role,'waiting');assert.equal(room.players.host.isHost,true);
});
test('instant restart atomically starts a fresh countdown with the same roster and rotated roles',async()=>{
  const room=playing();room.phase='finished';room.roundId='old-round';
  room.settings.gameDuration=900;room.settings.center={lat:52.5,lng:13.4};
  room.players.guest.active=false;room.players.guest.status='caught';
  room.photoMetadata={guest:{image:'private'}};room.roundTracks={host:{points:[[1,1]]}};
  const players=Object.keys(room.players).sort();
  const result=await applyAction(room,'host',{action:'restartRound'});
  assert.equal(result.room.phase,'countdown');assert.notEqual(result.room.roundId,'old-round');
  assert.deepEqual(Object.keys(result.room.players).sort(),players);
  assert.ok(Object.values(result.room.players).every(player=>player.active));
  assert.notEqual(result.room.players.host.role,'seeker','the previous Seeker rotates out when the roster allows it');
  assert.equal(Object.values(result.room.players).filter(player=>player.role==='seeker').length,1);
  assert.deepEqual(result.room.settings.center,{lat:52.5,lng:13.4});assert.equal(result.room.settings.gameDuration,900);
  assert.deepEqual(result.room.photoMetadata,{});assert.deepEqual(result.room.roundTracks,{});
  assert.ok(result.room.phaseEndsAt>Date.now());
});
test('instant restart rejects an undersized roster without changing the finished round',async()=>{
  const room=playing();room.phase='finished';room.players.guest.status='left';room.players.guest.active=false;room.players.other.status='left';room.players.other.active=false;
  await assert.rejects(applyAction(room,'host',{action:'restartRound'}),/NOT_ENOUGH_PLAYERS/);
  assert.equal(room.phase,'finished');assert.equal(room.players.guest.status,'left');
});
test('leaving the room immediately finishes a round when only Hiders remain',async()=>{
  const room=playing();room.players.host.role='hider';room.players.host.status='hiding';
  room.players.guest.role='seeker';room.players.guest.status='seeker';
  await applyAction(room,'guest',{action:'leaveRoom'});
  assert.equal(room.phase,'finished');assert.equal(room.winner,'hiders');
  assert.match(room.announcement.message,/keine Seeker mehr/i);
});
test('leaving the room ends the round as soon as one active player remains',async()=>{
  const room=playing();
  await applyAction(room,'guest',{action:'leaveRoom'});
  assert.equal(room.phase,'playing');
  await applyAction(room,'other',{action:'leaveRoom'});
  assert.equal(room.phase,'finished');assert.equal(room.winner,'seekers');
  assert.equal(room.roundResults.length,3);
});
test('a host leaving an active round transfers control and is not restored next round', async () => {
  const room=playing(); room.phase='finished';
  await applyAction(room,'host',{action:'leaveRoom'});
  assert.equal(room.hostId,'guest');
  assert.equal(room.players.host.active,false);
  await applyAction(room,'guest',{action:'newRound'});
  assert.equal(room.players.host,undefined);
  assert.equal(room.players.guest.active,true);
  assert.equal(room.hostId,'guest');
});
test('expired phase deadlines catch up from original timestamps after host downtime', async () => {
  const room=playing(); room.phase='countdown';room.phaseEndsAt=Date.now()-10000000;
  const result=await settlePhases(room);
  assert.equal(result.phase,'finished');assert.equal(result.phaseEndsAt,null);
});
test('Firebase token verification rejects missing credentials and Google denial', async () => {
  await assert.rejects(authenticate(new Request('https://api.test')),/UNAUTHENTICATED/);
  await assert.rejects(authenticate(new Request('https://api.test',{headers:{Authorization:'Bearer invalid'}}),async()=>new Response('{}',{status:400})),/UNAUTHENTICATED/);
});

function d1() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../worker/migrations/0001.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../worker/migrations/0002_profiles.sql',import.meta.url),'utf8'));
  const prepare=(sql)=>({bind(...args) {const statement=sqlite.prepare(sql);return {
    async first() {return statement.get(...args) || null;},
    async run() {return {meta:{changes:Number(statement.run(...args).changes)}};}
  };}});
  return {prepare};
}
test('persistent accounts store only validated profile preferences and protect test mode', async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{const id=JSON.parse(options.body).idToken;return new Response(JSON.stringify({users:[{localId:id,providerUserInfo:id==='anon-account-test'?[]:[{providerId:'password'}]}]}),{status:200});};
  try {
    const env={DB:d1(),ALLOWED_ORIGIN:'https://knekkonn.github.io',TEST_MODE_CODE:'test-code-123'};
    const request=(uid,path,body)=>new Request(`https://api.test${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${uid}`,Origin:env.ALLOWED_ORIGIN,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const saved=await worker.fetch(request('account-profile-test','/profile',{displayName:'Night Fox',cosmeticId:'violet',soundEnabled:false,hapticsEnabled:true}),env);
    assert.equal(saved.status,200);
    const stored=await (await worker.fetch(request('account-profile-test','/profile'),env)).json();
    assert.deepEqual(stored.profile,{displayName:'Night Fox',cosmeticId:'violet',soundEnabled:false,hapticsEnabled:true});
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM account_profiles').bind().first()).count,1,'email and password are not stored in D1');
    assert.equal((await worker.fetch(request('account-profile-test','/profile',{displayName:'a','cosmeticId':'not-a-cosmetic'}),env)).status,400);
    assert.equal((await worker.fetch(request('anon-account-test','/profile'),env)).status,401,'anonymous users cannot persist profiles');
    assert.equal((await worker.fetch(request('account-profile-test','/test-mode',{code:'wrong'}),env)).status,403);
    assert.equal((await worker.fetch(request('account-profile-test','/test-mode',{code:'test-code-123'}),env)).status,200);
  } finally {globalThis.fetch=originalFetch;}
});
test('player cosmetics can only be synchronized by the owning room member', async () => {
  const room=playing(); room.phase='lobby'; const timestamp=Date.now();
  await applyAction(room,'guest',{action:'syncProfile',displayName:'Runner Fox',cosmeticId:'rose'},timestamp);
  assert.equal(room.players.guest.name,'Runner Fox');
  assert.equal(room.players.guest.cosmeticId,'rose');
  await assert.rejects(applyAction(room,'guest',{action:'syncProfile',displayName:'Runner Fox',cosmeticId:'admin'},timestamp),/PROFILE_INVALID/);
  await assert.rejects(applyAction(room,'outsider',{action:'syncProfile',displayName:'Other',cosmeticId:'lime'},timestamp),/NOT_MEMBER/);
});
test('HTTP/D1 integration joins players directly and blocks outsider reads', async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>new Response(JSON.stringify({users:[{localId:JSON.parse(options.body).idToken}]}),{status:200});
  try {
    const env={DB:d1(),ALLOWED_ORIGIN:'https://knekkonn.github.io'};
    const request=(uid,body,path='/rooms/1234')=>new Request(`https://api.test${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${uid}`,Origin:env.ALLOWED_ORIGIN,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await worker.fetch(request('host',{action:'create',name:'HOST'}),env)).status,200);
    const initial=await (await worker.fetch(request('host'),env)).json();
    assert.ok(initial.room,'the initial revision 0 fetch must return the room rather than an unchanged marker');
    assert.equal(initial.revision,0);
    const unchangedZero=await (await worker.fetch(request('host',null,'/rooms/1234?since=0'),env)).json();
    assert.equal(unchangedZero.unchanged,true);
    assert.equal((await worker.fetch(request('stranger'),env)).status,403);
    const joins=await Promise.all(['guest','other'].map(uid=>worker.fetch(request(uid,{action:'join',name:uid.toUpperCase()}),env)));
    assert.deepEqual(joins.map(r=>r.status),[200,200]);
    const {room}=await (await worker.fetch(request('host'),env)).json();
    assert.equal(Object.keys(room.players).length,3);
    assert.equal(room.joinRequests,undefined);
    assert.equal((await worker.fetch(request('guest',{action:'settings',patch:{radius:2000}}),env)).status,403);
    const guestView=await (await worker.fetch(request('guest'),env)).json();
    assert.equal(Object.keys(guestView.room.players).length,3);
    assert.equal(guestView.room.joinRequests,undefined);
    assert.ok(Number.isSafeInteger(guestView.revision));
    const unchanged=await (await worker.fetch(request('guest',null,`/rooms/1234?since=${guestView.revision}`),env)).json();
    assert.equal(unchanged.unchanged,true);
    assert.equal(unchanged.room,undefined,'unchanged polling does not resend the room state');
  } finally {globalThis.fetch=originalFetch;}
});

test('server counts only continuous accurate outside evidence and applies the third-violation penalty', async (t) => {
  let timestamp=2000000000000;
  t.mock.method(Date,'now',()=>timestamp);
  const room=playing();room.players.guest.coins=50;
  const location=(outside=true,accuracy=5)=>({lat:outside?.01:0,lng:0,accuracy,measuredAt:timestamp});
  const send=async(outside=true,accuracy=5)=>applyAction(room,'guest',{action:'updatePlayerLocation',location:location(outside,accuracy)},timestamp);
  await send();
  timestamp+=35000; await send();
  assert.equal(room.players.guest.zone.violations,0,'an offline gap must not create a violation');
  timestamp+=5000;await send(true,100);
  assert.equal(room.players.guest.zone.status,'uncertain');
  for(let count=1;count<=3;count++) {
    timestamp+=5000;await send(false);
    for(let i=0;i<=6;i++) {timestamp+=5000;await send();}
    assert.equal(room.players.guest.zone.violations,count);
    assert.equal(room.players.guest.coins,50-count*5);
  }
  assert.equal(room.players.guest.effects.frozenUntil,timestamp+30000);
});

test('disabling the play zone removes boundary enforcement without disabling GPS-backed catches', async () => {
  const room=playing();room.settings.zoneEnabled=false;room.players.guest.coins=50;
  const timestamp=Date.now();
  await applyAction(room,'guest',{action:'updatePlayerLocation',location:{lat:.01,lng:0,accuracy:5,measuredAt:timestamp}},timestamp);
  assert.equal(room.players.guest.zone.status,'inside');
  assert.equal(room.players.guest.zone.violations,0);
  assert.equal(room.players.guest.coins,50);
});
