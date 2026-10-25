import test from 'node:test';
import assert from 'node:assert/strict';
import { transactRoom, normalizeRoom } from '../js/transactions.js';
import { evaluateZone, makeLocationSample } from '../js/gps.js';
import { createRoomData, addPlayerToRoom, updateSettings } from '../js/game-service.js';

test('cold transaction cache retries against the existing server lobby', async () => {
  const server = createRoomData('host','HOST');
  const api = {async runTransaction(ref, update, options) {
    assert.equal(options.applyLocally,false);
    assert.equal(update(null),null, 'must not abort on a cold cache');
    const value = update(server);
    return {committed:true,snapshot:{val:()=>value}};
  }};
  const room = await transactRoom(api, '1234', (current) => {
    assert.equal(addPlayerToRoom(current,'guest','GUEST').ok,true);
    return current;
  });
  assert.equal(Object.keys(room.players).length,2);
});

test('missing and rejected room transactions do not report success', async () => {
  for (const committed of [true,false]) {
    const api = {runTransaction:async () => ({committed,snapshot:{val:()=>null}})};
    assert.equal(await transactRoom(api,'0000',()=>{throw Error('not called');}),null);
  }
});

test('GPS samples use fresh callback time instead of a stale browser timestamp', () => {
  const sample=makeLocationSample({timestamp:978307296000,coords:{latitude:52.5,longitude:13.4,accuracy:5,altitude:42,altitudeAccuracy:10}},2000000000000);
  assert.equal(sample.measuredAt,2000000000000);
  assert.equal(sample.altitude,42);
  assert.throws(()=>makeLocationSample({coords:{latitude:91,longitude:13,accuracy:5}},2000000000000),/INVALID_GPS_SAMPLE/);
});

test('Firebase omitted empty maps and inventories are normalized', () => {
  const room = normalizeRoom({players:{a:{name:'A'}}});
  assert.deepEqual(room.effects,{});
  assert.deepEqual(room.players.a.inventory,[]);
});

test('repeated membership mutation preserves everyone and is idempotent', () => {
  const room = createRoomData('host','HOST');
  for (let i=0;i<10;i++) assert.equal(addPlayerToRoom(room,`guest${i}`,`NAME${i}`).ok,true);
  addPlayerToRoom(room,'guest0','CHANGED');
  assert.equal(Object.keys(room.players).length,11);
  assert.equal(room.players.guest0.name,'NAME0');
});

test('closed and finished rooms reject even an existing member', () => {
  for (const phase of ['closed','finished']) {
    const room = createRoomData('host','HOST'); room.phase = phase;
    assert.equal(addPlayerToRoom(room,'host','HOST').ok,false);
  }
});

test('settings reject unexpected fields and invalid center coordinates', () => {
  const room = createRoomData('host','HOST');
  updateSettings(room,'host',{hostId:'guest',center:{lat:999,lng:0},skills:{invented:true},mode:'invalid'});
  assert.equal(room.hostId,'host'); assert.equal(room.settings.center,undefined);
  assert.equal(room.settings.mode,'classic'); assert.equal(room.settings.skills.invented,undefined);
});

const center = {lat:0,lng:0};
const outside = {lat:0.01,lng:0,accuracy:5,measuredAt:100000};
const sample = (location=outside,timestamp=100000,connected=true) => ({location,center,radius:500,timestamp,connected});
test('a single outside reading warns, never immediately confirms', () => {
  const state = evaluateZone(null,sample());
  assert.equal(state.status,'warning'); assert.equal(state.remaining,30);
});
test('30 seconds of fresh reliable readings are required', () => {
  let state = evaluateZone(null,sample());
  for (let t=105000;t<=130000;t+=5000) state=evaluateZone(state,sample({...outside,measuredAt:t},t));
  assert.equal(state.status,'outside');
});
test('offline, stale, missing and inaccurate GPS reset the tolerance window', () => {
  const previous = evaluateZone(null,sample());
  const cases = [sample(outside,105000,false),sample(null),sample(outside,120000),sample({...outside,accuracy:100})];
  for (const input of cases) {
    const result = evaluateZone(previous,input);
    assert.equal(result.outsideSince,null);
    const recovered = evaluateZone(result,sample({...outside,measuredAt:130000},130000));
    assert.equal(recovered.remaining,30);
  }
});
test('a position whose accuracy overlaps the boundary is uncertain', () => {
  assert.equal(evaluateZone(null,sample({lat:0.0045,lng:0,accuracy:25,measuredAt:100000})).status,'uncertain');
});
