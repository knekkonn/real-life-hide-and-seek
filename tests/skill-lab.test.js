import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkillLabSession, setSkillLabRadius, queueSkillLabPlacement, activateSkillLabSkill, activateSkillLabTactical, moveSkillLabTarget, attemptSkillLabCatch, skillLabSnapshot } from '../js/skill-lab.js';
import { skillTuning, tacticalTuning } from '../js/skills.js';

test('practice sessions grant only the selected role skills and reset inventory locally', () => {
  const seeker=createSkillLabSession('seeker',500);
  assert.ok(seeker.inventory.includes('sonar'));
  assert.ok(!seeker.inventory.includes('ghost'));
  assert.equal(activateSkillLabSkill(seeker,'ghost').ok,false);
  assert.equal(activateSkillLabSkill(seeker,'sonar').ok,true);
  assert.ok(!seeker.inventory.includes('sonar'));
  const reset=createSkillLabSession('seeker',500);
  assert.ok(reset.inventory.includes('sonar'));
  assert.equal(reset.effects.sonarUntil,undefined);
});

test('skill lab uses real skill tuning when zone size changes', () => {
  const session=createSkillLabSession('seeker',1000);
  const result=activateSkillLabSkill(session,'sweeper');
  assert.equal(result.ok,true);
  assert.equal(result.tuning.zoneRadius,1000);
  assert.equal(session.effects.lastSweepCount,1);
  setSkillLabRadius(session,25);
  assert.equal(session.radius,50);
});

test('decoy requires an in-zone placement within the configured ability range', () => {
  const session=createSkillLabSession('hider',500);
  assert.equal(queueSkillLabPlacement(session),true);
  assert.equal(activateSkillLabSkill(session,'decoy').needsPlacement,true);
  assert.equal(activateSkillLabSkill(session,'decoy',{x:70,y:50}).ok,false);
  assert.ok(session.inventory.includes('decoy'),'an invalid placement does not consume a skill');
  const result=activateSkillLabSkill(session,'decoy',{x:60,y:50});
  assert.equal(result.ok,true);
  assert.equal(skillLabSnapshot(session).decoys.length,1);
  assert.ok(!session.inventory.includes('decoy'));
});

test('tracker reveals its nearest target and jammer blocks the Hider radar', () => {
  const seeker=createSkillLabSession('seeker',500);
  assert.equal(activateSkillLabSkill(seeker,'tracker').ok,true);
  const visible=skillLabSnapshot(seeker).actors.filter(actor=>actor.role==='hider');
  assert.deepEqual(visible.map(actor=>actor.id),['hider-near']);

  const hider=createSkillLabSession('hider',500);
  hider.effects.jammerUntil=Date.now()+10_000;
  assert.equal(activateSkillLabSkill(hider,'seekerradar').ok,true);
  assert.equal(skillLabSnapshot(hider).actors.some(actor=>actor.role==='seeker'),false);
  assert.equal(skillLabSnapshot(hider).jammed,true);
});

test('training catch enforces 8 m and the shield blocks one valid catch', () => {
  const seeker=createSkillLabSession('seeker',500);
  moveSkillLabTarget(seeker,8.1);
  assert.equal(attemptSkillLabCatch(seeker).ok,false);
  moveSkillLabTarget(seeker,8);
  assert.equal(attemptSkillLabCatch(seeker).ok,true);

  const hider=createSkillLabSession('hider',500);
  assert.equal(activateSkillLabSkill(hider,'shield').ok,true);
  moveSkillLabTarget(hider,8);
  const blocked=attemptSkillLabCatch(hider);
  assert.equal(blocked.blocked,true);
  assert.equal(hider.effects.shield,false);
  assert.equal(attemptSkillLabCatch(hider).caught,true);
});

test('practice Hider Mutprobe requires proximity and awards the same scaled points', () => {
  const hider=createSkillLabSession('hider',500),timestamp=Date.now();
  moveSkillLabTarget(hider,15);
  assert.equal(activateSkillLabSkill(hider,'closecall').ok,true);
  let snapshot;
  for(let elapsed=5000;elapsed<=20_000;elapsed+=5000) snapshot=skillLabSnapshot(hider,timestamp+elapsed);
  assert.equal(snapshot.score,120+tacticalTuning({radius:500}).closeCallReward);
  assert.equal(hider.effects.closecall,undefined);
});

test('practice Hider Frostimpuls freezes a nearby Seeker and shows the freeze on the test map', () => {
  const hider=createSkillLabSession('hider',500),tuning=skillTuning('freeze',{radius:500});
  moveSkillLabTarget(hider,20);
  const result=activateSkillLabSkill(hider,'freeze');
  assert.equal(result.ok,true);
  const seeker=skillLabSnapshot(hider).actors.find(actor=>actor.role==='seeker');
  assert.equal(seeker.frozen,true);
  assert.ok(!hider.inventory.includes('freeze'));
  assert.ok(seeker);
  assert.ok(tuning.freezeRadius>=12);
});

test('practice Seeker strategic powers spend points and use scaled values', () => {
  const seeker=createSkillLabSession('seeker',1000),tuning=tacticalTuning({radius:1000});
  assert.equal(activateSkillLabTactical(seeker,'zone',{x:57,y:50}).ok,true);
  assert.equal(seeker.score,120-tuning.zoneCost);
  assert.equal(skillLabSnapshot(seeker).restrictedZones.length,1);
  assert.equal(activateSkillLabTactical(seeker,'exchangeTime',{seconds:30}).ok,true);
  assert.equal(seeker.score,120-tuning.zoneCost+tuning.exchangeReward(30));
  assert.equal(activateSkillLabTactical(seeker,'relocate',{mode:'random'}).ok,true);
  assert.equal(skillLabSnapshot(seeker).forcedHiders.length,1);
});
