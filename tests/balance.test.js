import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomData, addPlayerToRoom } from '../js/game-service.js';
import { applyAction, publicRoom } from '../worker/game.js';
import { SKILL_IDS, skillTuning, tacticalTuning } from '../js/skills.js';
import { createTaskLabSession, startTaskLabTask, advanceTaskLabCloseCall, advanceTaskLabStay, completeTaskLabTask, cancelTaskLabTask } from '../js/task-lab.js';

function playing(timestamp=Date.now()) {
  const room=createRoomData('host','HOST'); room.code='1234';
  addPlayerToRoom(room,'guest','GUEST'); addPlayerToRoom(room,'other','OTHER');
  room.phase='playing'; room.settings.center={lat:0,lng:0}; room.matchEndsAt=timestamp+1200000;
  for(const player of Object.values(room.players)) {
    player.role=player.id==='host'?'seeker':'hider'; player.active=true; player.status=player.role;
    player.location={lat:0,lng:0,accuracy:5,measuredAt:timestamp}; player.locationAt=timestamp;
  }
  return room;
}
function jpeg() {
  const bytes=[0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x00,0xf0,0x01,0x40,0x03,0x01,0x11,0x00,0x02,0x11,0x00,0x03,0x11,0x00,0xff,0xda,0x00,0x0c,0x03,0x01,0x00,0x02,0x11,0x03,0x11,0x00,0x3f,0x00,...new Array(120).fill(0x11),0xff,0xd9];
  return 'data:image/jpeg;base64,'+Buffer.from(bytes).toString('base64');
}
async function startPhoto(room,timestamp) {
  const {result}=await applyAction(room,'guest',{action:'beginTask',kind:'photo'},timestamp);
  await applyAction(room,'guest',{action:'submitPhoto',taskId:result.id,image:jpeg()},timestamp);
  return result.id;
}
async function update(room,uid,timestamp,{lat=0,accuracy=5,measuredAt=timestamp}={}) {
  return applyAction(room,uid,{action:'updatePlayerLocation',location:{lat,lng:0,accuracy,measuredAt}},timestamp);
}

test('photo rewards require 180 verified seconds and cannot be replayed',async()=>{
  const timestamp=Date.now(),room=playing(timestamp),id=await startPhoto(room,timestamp);
  assert.equal(room.players.guest.coins,0);
  assert.equal(publicRoom(room,'host',timestamp).players.guest.activeTask,undefined);
  for(let s=5;s<=175;s+=5) await update(room,'guest',timestamp+s*1000);
  assert.equal(room.players.guest.coins,0,'not even at 175 seconds');
  await update(room,'guest',timestamp+180000);
  assert.equal(room.players.guest.coins,45);
  assert.equal(room.players.guest.tasksSolved,1);
  for(let i=0;i<3;i++) await update(room,'guest',timestamp+180000);
  assert.equal(room.players.guest.coins,45);
  await assert.rejects(applyAction(room,'guest',{action:'completeTask',proof:{id}},timestamp+181000),/INVALID_CHALLENGE/);
  await assert.rejects(applyAction(room,'guest',{action:'beginTask',kind:'photo'},timestamp+211000),/PHOTO_ALREADY_SUBMITTED/);
});

test('photo movement and explicit cancellation deduct 15 points only once',async()=>{
  for(const cancel of [false,true]) {
    const timestamp=Date.now(),room=playing(timestamp),id=await startPhoto(room,timestamp);
    if(cancel) await applyAction(room,'guest',{action:'failTask',taskId:id},timestamp+5000);
    else await update(room,'guest',timestamp+5000,{lat:.0003});
    assert.equal(room.players.guest.score,-15);
    assert.equal(room.players.guest.coins,0);
    assert.equal(room.players.guest.activeTask.failed,true);
    assert.equal(room.players.guest.taskCooldownUntil,timestamp+125000);
    await applyAction(room,'guest',{action:'failTask',taskId:id},timestamp+6000);
    await update(room,'guest',timestamp+7000,{lat:.0004});
    assert.equal(room.players.guest.score,-15,'no repeated penalty');
  }
});

test('photo GPS gaps, uncertain fixes and repeated samples never manufacture hold time or penalties',async()=>{
  const timestamp=Date.now(),room=playing(timestamp); await startPhoto(room,timestamp);
  await update(room,'guest',timestamp+5000);
  await update(room,'guest',timestamp+6000,{measuredAt:timestamp+5000});
  assert.equal(room.players.guest.activeTask.heldMs,5000);
  await update(room,'guest',timestamp+16000);
  assert.equal(room.players.guest.activeTask.heldMs,0);
  await update(room,'guest',timestamp+21000,{lat:.0003,accuracy:50});
  assert.equal(room.players.guest.score,0);
  assert.equal(room.players.guest.activeTask.failed,false);
  await update(room,'guest',timestamp+26000);
  await update(room,'guest',timestamp+31000);
  assert.equal(room.players.guest.activeTask.heldMs,5000);
  assert.equal(room.players.guest.coins,0);
});

test('photo cannot start its hold too late or be abandoned through a forged completion ID',async()=>{
  const timestamp=Date.now(),room=playing(timestamp),id=await startPhoto(room,timestamp);
  await assert.rejects(applyAction(room,'guest',{action:'completeTask',proof:{id:'forged'}},timestamp+5000),/INVALID_CHALLENGE/);
  assert.equal(room.players.guest.activeTask.failed,false);
  const lateRoom=playing(timestamp);lateRoom.matchEndsAt=timestamp+179000;
  const started=await applyAction(lateRoom,'guest',{action:'beginTask',kind:'photo'},timestamp);
  await assert.rejects(applyAction(lateRoom,'guest',{action:'submitPhoto',taskId:started.result.id,image:jpeg()},timestamp),/TASK_TIME_REQUIRED/);
  assert.equal(lateRoom.photoMetadata,undefined);
  assert.ok(id);
});

test('Mutprobe never scores twice for cached GPS or after its capped sixty seconds',async()=>{
  const timestamp=Date.now(),room=playing(timestamp);
  await applyAction(room,'guest',{action:'beginTask',kind:'closecall'},timestamp);
  for(const uid of ['host','guest']) await update(room,uid,timestamp+5000);
  assert.equal(room.players.guest.score,5);
  for(const uid of ['host','guest']) await update(room,uid,timestamp+10000,{measuredAt:timestamp+5000});
  assert.equal(room.players.guest.score,5);
  for(const uid of ['host','guest']) await update(room,uid,timestamp+16000);
  assert.equal(room.players.guest.activeTask.completed,true);
  assert.equal(room.players.guest.score,5);
});

test('permanent zones follow a shortened round and cannot be purchased twice',async()=>{
  const timestamp=Date.now(),room=playing(timestamp);room.players.host.score=300;
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'zone',center:{lat:0,lng:.002}},timestamp);
  const zone=Object.values(room.restrictedZones)[0];
  assert.equal(zone.expiresAt,room.matchEndsAt);
  await applyAction(room,'host',{action:'useTacticalAbility',ability:'exchangeTime',seconds:90},timestamp+1000);
  assert.equal(zone.expiresAt,room.matchEndsAt);
  await assert.rejects(applyAction(room,'host',{action:'useTacticalAbility',ability:'zone',center:{lat:0,lng:0}},timestamp+2000),/ABILITY_COOLDOWN/);
});

test('price order, area limits and duration bounds hold across every allowed field and round size',()=>{
  for(const radius of [50,75,100,250,500,1000,2000]) for(const gameDuration of [300,600,1200,1800]) {
    const settings={radius,gameDuration},t=tacticalTuning(settings);
    for(const count of [1,2,19]) assert.ok(t.relocationCost('random')<t.relocationCost('one')&&t.relocationCost('one')<t.relocationCost('all',count));
    assert.ok(t.zoneRadius>=radius*.25 && t.zoneRadius<=t.maxZoneRadius);
    assert.ok(t.maxZoneRadius<=radius*.45);
    assert.ok(t.zoneCostFor(t.minZoneRadius)<=t.zoneCostFor(t.zoneRadius));
    assert.ok(t.zoneCostFor(t.zoneRadius)<t.zoneCostFor(t.maxZoneRadius));
    for(const id of SKILL_IDS) {
      const skill=skillTuning(id,settings);
      assert.ok(Number.isFinite(skill.price)&&skill.price>=10);
      assert.ok(skill.duration<=gameDuration*.5);
      assert.ok(skill.sweepRadius<=radius && skill.decoyRange<=radius);
    }
  }
  assert.ok(tacticalTuning({radius:2000,gameDuration:1800}).zoneCost>tacticalTuning({radius:50,gameDuration:300}).zoneCost);
  assert.ok(skillTuning('tracker',{radius:500,gameDuration:300}).duration<skillTuning('tracker',{radius:500,gameDuration:1800}).duration);
});

test('Frostimpuls cannot chain freezes or consume another item during Seeker immunity',async()=>{
  const timestamp=Date.now(),room=playing(timestamp);room.players.guest.inventory=['freeze','freeze'];
  await applyAction(room,'guest',{action:'activateSkill',skillId:'freeze'},timestamp);
  const until=room.players.host.effects.freezeImmuneUntil;
  for(const uid of ['host','guest']) await update(room,uid,timestamp+10000);
  await assert.rejects(applyAction(room,'guest',{action:'activateSkill',skillId:'freeze'},timestamp+10000),/ABILITY_COOLDOWN/);
  assert.deepEqual(room.players.guest.inventory,['freeze']);
  for(const uid of ['host','guest']) await update(room,uid,until);
  await applyAction(room,'guest',{action:'activateSkill',skillId:'freeze'},until);
  assert.equal(room.players.guest.inventory.length,0);
});

test('task sandbox uses the same once-only score and photo-hold penalties',()=>{
  const lab=createTaskLabSession('hider');startTaskLabTask(lab,'closecall',1000);
  for(let i=0;i<12;i++) advanceTaskLabCloseCall(lab,5,2000+i);
  assert.equal(lab.score,60);assert.equal(lab.credits,0);assert.equal(lab.active,null);
  assert.equal(startTaskLabTask(lab,'closecall',10000).ok,false);
  startTaskLabTask(lab,'photo',10000);
  completeTaskLabTask(lab,{photoData:jpeg()},11000);advanceTaskLabStay(lab,60);
  cancelTaskLabTask(lab,12000);
  assert.equal(lab.score,45);assert.equal(lab.credits,0);
});
