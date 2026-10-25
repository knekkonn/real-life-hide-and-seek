import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { applyAction, publicRoom, settlePhases } from '../worker/game.js';
import { authenticate } from '../worker/auth.js';
import { createRoomData, addPlayerToRoom } from '../js/game-service.js';
import { findSafeItemLocations } from '../worker/itembox.js';

function playing() {
  const room=createRoomData('host','HOST'); room.code='1234';
  addPlayerToRoom(room,'guest','GUEST'); addPlayerToRoom(room,'other','OTHER');
  room.phase='playing'; room.settings.center={lat:0,lng:0};
  for (const p of Object.values(room.players)) {p.role=p.id==='host'?'seeker':'hider';p.status=p.role;p.active=true;p.location={lat:0,lng:0,accuracy:5,measuredAt:Date.now()};p.locationAt=Date.now();}
  return room;
}
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
test('a code only requests entry; a host must approve membership', async () => {
  const room=createRoomData('host','HOST');
  await applyAction(room,'guest',{action:'join',name:'GUEST'});
  assert.equal(room.players.guest,undefined);
  assert.equal(publicRoom(room,'guest').phase,'pending');
  await assert.rejects(applyAction(room,'guest',{action:'settings',patch:{radius:2000}}),/NOT_MEMBER/);
  await applyAction(room,'host',{action:'approveJoin',targetId:'guest'});
  assert.ok(room.players.guest);
  await assert.rejects(applyAction(room,'guest',{action:'settings',patch:{radius:2000}}),/HOST_ONLY/);
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
test('catch requires fresh accurate positions within the allowed radius', async () => {
  const room=playing();
  room.players.guest.location={lat:.00005,lng:0,accuracy:5,measuredAt:Date.now()};room.players.guest.locationAt=Date.now();
  await assert.rejects(applyAction(room,'host',{action:'requestCatch',targetId:'guest'}),/CATCH_RANGE_REQUIRED/);
  assert.equal(room.players.guest.role,'hider');
  const close=playing();close.settings.mode='infected';close.players.guest.location={lat:.00004,lng:0,accuracy:5,measuredAt:Date.now()};close.players.guest.locationAt=Date.now();
  await applyAction(close,'host',{action:'requestCatch',targetId:'guest'});
  assert.equal(close.players.guest.role,'seeker','a GPS distance below 5 m is accepted');
  const outside=playing();outside.players.guest.location={lat:.00006,lng:0,accuracy:5,measuredAt:Date.now()};outside.players.guest.locationAt=Date.now();
  await assert.rejects(applyAction(outside,'host',{action:'requestCatch',targetId:'guest'}),/CATCH_RANGE_REQUIRED/);
  room.players.guest.location={lat:0,lng:0,accuracy:45,measuredAt:Date.now()};room.players.guest.locationAt=Date.now();
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
test('server-issued Vigenere and columnar ciphers are private, rate-limited and redeem once', async () => {
  const room=playing(); const timestamp=Date.now();
  const {result}=await applyAction(room,'guest',{action:'beginTask',kind:'cipher'},timestamp);
  const challenge=room.players.guest.activeTask;
  assert.match(result.prompt,/Vigenère rückwärts/);
  assert.match(result.prompt,/Spaltentransposition/);
  const key=result.prompt.match(/Schlüssel: ([A-Z]+)/)[1];
  const order=result.prompt.match(/Reihenfolge: ([1-4]–[1-4]–[1-4]–[1-4])/)[1].split('–').map(n=>Number(n)-1);
  const ciphertext=result.prompt.match(/VERSCHLÜSSELTER TEXT: ([A-Z]{12})/)[1];
  const transposed=Array.from(ciphertext,(char,i)=>String.fromCharCode(65+(char.charCodeAt(0)-65-(key.charCodeAt(i%key.length)-65)+26)%26)).join('');
  const grid=Array(12);let cursor=0;for(const col of order)for(let row=0;row<3;row++)grid[row*4+col]=transposed[cursor++];
  assert.equal(grid.join(''),challenge.answer,'published instructions must decode the server-held code');
  assert.equal(publicRoom(room,'guest',timestamp).players.guest.activeTask.answer,undefined);
  assert.equal(publicRoom(room,'host',timestamp).players.guest.activeTask,undefined);
  const tooFast=await applyAction(room,'guest',{action:'completeTask',proof:{id:result.id,answer:challenge.answer}},timestamp+1000);
  assert.equal(tooFast.result.error,'TASK_TOO_FAST');
  assert.equal(room.players.guest.taskCooldownUntil,timestamp+121000);
  assert.equal(room.players.guest.coins,0);

  const successRoom=playing();
  const started=await applyAction(successRoom,'guest',{action:'beginTask',kind:'cipher'},timestamp);
  const answer=successRoom.players.guest.activeTask.answer;
  const reward=await applyAction(successRoom,'guest',{action:'completeTask',proof:{id:started.result.id,answer}},timestamp+31000);
  assert.equal(reward.result,true);
  assert.equal(successRoom.players.guest.coins,25);
  await assert.rejects(applyAction(successRoom,'guest',{action:'completeTask',proof:{id:started.result.id,answer}},timestamp+32000),/INVALID_CHALLENGE/);
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
  await assert.rejects(applyAction(room,'guest',{action:'beginTask',kind:'photo'},timestamp+32000),/PHOTO_ALREADY_SUBMITTED/);
  room.phase='finished';
  const finished=await applyAction(room,'host',{action:'advanceExpiredPhase'});
  assert.deepEqual(finished.room.photoMetadata,{});
  assert.equal(publicRoom(finished.room,'host',timestamp+33000).roundPhotos,undefined);

  const exifRoom=playing();const exifStart=await applyAction(exifRoom,'guest',{action:'beginTask',kind:'photo'},timestamp);
  const exif=new Uint8Array([...jpeg.slice(0,2),0xff,0xe1,0,8,0x45,0x78,0x69,0x66,0,0,...jpeg.slice(2)]);
  const rejected=await applyAction(exifRoom,'guest',{action:'submitPhoto',taskId:exifStart.result.id,image:'data:image/jpeg;base64,'+Buffer.from(exif).toString('base64')},timestamp+1000);
  assert.equal(rejected.result.error,'INVALID_PHOTO');
  assert.equal(exifRoom.photoMetadata?.guest,undefined,'EXIF-bearing images are not stored');
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

test('new round resets player locations and last departure clears all room player data', async () => {
  const room=playing(); room.phase='finished';room.players.guest.location={lat:1,lng:1};room.photoMetadata={guest:{image:'private'}};
  await applyAction(room,'host',{action:'newRound'});
  assert.equal(room.phase,'lobby');assert.equal(room.players.guest.role,'waiting');assert.equal(room.players.guest.location,null);assert.deepEqual(room.photoMetadata,{});
  await applyAction(room,'host',{action:'leaveRoom'});
  assert.equal(Object.keys(room.players).length,3,'remaining player data is retained until the room is empty');
  await applyAction(room,'guest',{action:'leaveRoom'});
  assert.equal(Object.keys(room.players).length,3,'player records are cleared only after every player has left');
  await applyAction(room,'other',{action:'leaveRoom'});
  assert.equal(room.phase,'closed');assert.deepEqual(room.players,{});assert.deepEqual(room.photoMetadata,{});assert.equal(room.hostId,null);assert.equal(room.settings.center,null);
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
  const prepare=(sql)=>({bind(...args) {const statement=sqlite.prepare(sql);return {
    async first() {return statement.get(...args) || null;},
    async run() {return {meta:{changes:Number(statement.run(...args).changes)}};}
  };}});
  return {prepare};
}
test('HTTP/D1 integration preserves concurrent join requests and blocks outsider reads', async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>new Response(JSON.stringify({users:[{localId:JSON.parse(options.body).idToken}]}),{status:200});
  try {
    const env={DB:d1(),ALLOWED_ORIGIN:'https://knekkonn.github.io'};
    const request=(uid,body)=>new Request('https://api.test/rooms/1234',{method:body?'POST':'GET',headers:{Authorization:`Bearer ${uid}`,Origin:env.ALLOWED_ORIGIN,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await worker.fetch(request('host',{action:'create',name:'HOST'}),env)).status,200);
    assert.equal((await worker.fetch(request('stranger'),env)).status,403);
    const joins=await Promise.all(['guest','other'].map(uid=>worker.fetch(request(uid,{action:'join',name:uid.toUpperCase()}),env)));
    assert.deepEqual(joins.map(r=>r.status),[200,200]);
    const {room}=await (await worker.fetch(request('host'),env)).json();
    assert.equal(Object.keys(room.joinRequests).length,2);
    assert.equal(Object.keys(room.players).length,1);
    assert.equal((await worker.fetch(request('guest',{action:'settings',patch:{radius:2000}}),env)).status,403);
    assert.equal((await worker.fetch(request('host',{action:'approveJoin',targetId:'guest'}),env)).status,200);
    const guestView=await (await worker.fetch(request('guest'),env)).json();
    assert.equal(Object.keys(guestView.room.players).length,2);
    assert.equal(guestView.room.joinRequests,undefined);
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
