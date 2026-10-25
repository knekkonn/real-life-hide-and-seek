import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomData, addPlayerToRoom, updateSettings, startCountdown } from '../js/game-service.js';
import { distanceMeters, randomPointInRadius } from '../js/utils.js';

test('new lobby contains one host and defaults to lobby phase', () => {
  const room = createRoomData('host-1', 'NIGHTHAWK');
  assert.equal(room.phase, 'lobby');
  assert.equal(room.hostId, 'host-1');
  assert.equal(room.players['host-1'].isHost, true);
  assert.equal(room.settings.mode, 'classic');
  assert.equal(room.settings.radius, 500);
});

test('join validation blocks duplicate names and full lobbies', () => {
  const room = createRoomData('host-1', 'NIGHTHAWK');
  assert.equal(addPlayerToRoom(room, 'player-2', 'EMBER').ok, true);
  assert.equal(addPlayerToRoom(room, 'player-3', 'ember').ok, false);
  for (let index = 3; index <= 20; index++) {
    const result = addPlayerToRoom(room, `player-${index}`, `PLAYER-${index}`);
    assert.equal(result.ok, true);
  }
  assert.equal(addPlayerToRoom(room, 'player-21', 'LAST-PLAYER').ok, false);
});

test('host settings are clamped and non-host writes are rejected', () => {
  const room = createRoomData('host-1', 'NIGHTHAWK');
  assert.equal(updateSettings(room, 'guest', { radius:1500 }), null);
  updateSettings(room, 'host-1', { hideDuration:1, gameDuration:99999, radius:2400, skills:{ sonar:false } });
  assert.equal(room.settings.hideDuration, 120);
  assert.equal(room.settings.gameDuration, 1800);
  assert.equal(room.settings.radius, 1500);
  assert.equal(room.settings.skills.sonar, false);
  assert.equal(room.settings.skills.tracker, true);
});

test('start assigns exactly one initial seeker and starts synced countdown', () => {
  const room = createRoomData('host-1', 'NIGHTHAWK');
  addPlayerToRoom(room, 'player-2', 'EMBER');
  addPlayerToRoom(room, 'player-3', 'GHOST');
  const result = startCountdown(room, 'host-1', {lat:52.5,lng:13.4});
  assert.equal(result.ok, true);
  assert.equal(room.phase, 'countdown');
  assert.ok(room.phaseEndsAt - Date.now() >= 9_900);
  assert.equal(Object.values(room.players).filter((player) => player.role === 'seeker').length, 1);
  assert.equal(Object.values(room.players).filter((player) => player.role === 'hider').length, 2);
  assert.deepEqual(room.settings.center, {lat:52.5,lng:13.4});
  assert.ok(Object.values(room.players).filter((player) => player.role === 'hider').every((player) => player.inventory.length <= 1));
});

test('countdown cannot start with one player or a non-host', () => {
  const room = createRoomData('host-1', 'NIGHTHAWK');
  assert.equal(startCountdown(room, 'host-1', null).ok, false);
  addPlayerToRoom(room, 'player-2', 'EMBER');
  assert.equal(startCountdown(room, 'player-2', null).ok, false);
});

test('GPS math returns plausible distances and points within the requested radius', () => {
  const origin = {lat:52.52,lng:13.405};
  assert.ok(distanceMeters(origin, {lat:52.5201,lng:13.405}) > 10);
  assert.ok(distanceMeters(origin, {lat:52.5201,lng:13.405}) < 12);
  for (let index=0; index<25; index++) {
    const point = randomPointInRadius(origin, 500);
    assert.ok(distanceMeters(origin, point) <= 410);
  }
});


test('existing players can reconnect after the lobby phase started', () => {
  const room = createRoomData('host-1', 'NIGHTHAWK');
  addPlayerToRoom(room, 'player-2', 'EMBER');
  assert.equal(startCountdown(room, 'host-1', null).ok, true);
  assert.equal(addPlayerToRoom(room, 'player-2', 'RENAMED').ok, true);
  assert.equal(room.players['player-2'].name, 'EMBER');
  room.players['player-2'].previousStatus = 'hiding';
  room.players['player-2'].status = 'left';
  room.players['player-2'].active = false;
  assert.equal(addPlayerToRoom(room, 'player-2', 'EMBER').ok, true);
  assert.equal(room.players['player-2'].active, true);
  assert.equal(room.players['player-2'].status, 'hiding');
});

test('host can configure multiple randomized seekers and both roles receive a random starting skill', () => {
  const room = createRoomData('host-1', 'NIGHTHAWK');
  for (let index = 2; index <= 8; index++) addPlayerToRoom(room, `player-${index}`, `PLAYER-${index}`);
  updateSettings(room, 'host-1', { seekerCount:3 });
  const result = startCountdown(room, 'host-1', {lat:52.5,lng:13.4});
  assert.equal(result.ok, true);
  const players = Object.values(room.players);
  assert.equal(players.filter((player) => player.role === 'seeker').length, 3);
  assert.equal(players.filter((player) => player.role === 'hider').length, 5);
  assert.ok(players.every((player) => player.inventory.length === 1));
  assert.ok(players.filter((player) => player.role === 'seeker').every((player) => ['sonar','tracker','jammer','sprint','sweeper','compass'].includes(player.inventory[0])));
  assert.ok(players.filter((player) => player.role === 'hider').every((player) => ['ghost','decoy','trap','shield','seekerradar','silent'].includes(player.inventory[0])));
});

test('role settings never allow starting without a hider', () => {
  const room = createRoomData('host-1', 'NIGHTHAWK');
  addPlayerToRoom(room, 'player-2', 'EMBER');
  updateSettings(room, 'host-1', { seekerCount:2 });
  const result = startCountdown(room, 'host-1', null);
  assert.equal(result.ok, false);
  assert.equal(room.phase, 'lobby');
});
