import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { applyAction, publicRoom, settlePhases } from '../worker/game.js';
import { authenticate } from '../worker/auth.js';
import { createRoomData, addPlayerToRoom } from '../js/game-service.js';

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
test('catch requires the target identity and a current request ID; accepted infection is applied once', async () => {
  const room=playing();room.settings.mode='infected';
  await applyAction(room,'host',{action:'requestCatch',targetId:'guest'});
  const id=room.pendingCatch.id;
  await assert.rejects(applyAction(room,'other',{action:'respondToCatch',accepted:true,requestId:id}));
  assert.equal(room.players.guest.role,'hider');
  await assert.rejects(applyAction(room,'guest',{action:'respondToCatch',accepted:true,requestId:'old'}),/STALE_CATCH/);
  await applyAction(room,'guest',{action:'respondToCatch',accepted:true,requestId:id});
  assert.equal(room.players.guest.role,'seeker');
  await assert.rejects(applyAction(room,'guest',{action:'respondToCatch',accepted:true,requestId:id}),/STALE_CATCH/);
});
test('forged reward submissions cannot award currency', async () => {
  const room=playing();const before=room.players.guest.coins;
  await assert.rejects(applyAction(room,'guest',{action:'completeTask',kind:'code',proof:{id:'forged',answer:42}}),/INVALID_CHALLENGE/);
  assert.equal(room.players.guest.coins,before);
});
test('server-issued challenges require correct answer, delay and one-time redemption', async () => {
  const room=playing();
  const {result}=await applyAction(room,'guest',{action:'beginTask',kind:'code'});
  const challenge=room.challenges.guest;
  await assert.rejects(applyAction(room,'guest',{action:'completeTask',proof:{id:result.id,answer:challenge.answer}}),/INVALID_CHALLENGE/);
  challenge.createdAt=Date.now()-5000;
  await assert.rejects(applyAction(room,'guest',{action:'completeTask',proof:{id:result.id,answer:-1}}),/WRONG_ANSWER/);
  await applyAction(room,'guest',{action:'completeTask',proof:{id:result.id,answer:challenge.answer}});
  assert.equal(room.players.guest.coins,25);
  await assert.rejects(applyAction(room,'guest',{action:'completeTask',proof:{id:result.id,answer:challenge.answer}}),/INVALID_CHALLENGE/);
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
