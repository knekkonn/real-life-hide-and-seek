import { DEFAULT_SETTINGS, eligibleSkills, skillTuning, tacticalTuning } from './skills.js';

const TEAMMATES = {
  seeker:[
    {id:'hider-near',role:'hider',x:56,y:48,label:'Hider A'},
    {id:'hider-east',role:'hider',x:66,y:58,label:'Hider B'},
    {id:'hider-west',role:'hider',x:39,y:39,label:'Hider C'},
    {id:'seeker-ally',role:'seeker',x:43,y:58,label:'Seeker-Team'}
  ],
  hider:[
    {id:'seeker-north',role:'seeker',x:59,y:42,label:'Seeker A'},
    {id:'seeker-south',role:'seeker',x:39,y:58,label:'Seeker B'},
    {id:'hider-ally',role:'hider',x:66,y:57,label:'Hider-Team'}
  ]
};

const pointDistance = (a,b,radius) => Math.hypot(a.x-b.x,a.y-b.y)*radius/42;
const fresh = (until, timestamp) => Number(until)>timestamp;

export function createSkillLabSession(role='seeker', radius=500) {
  const safeRole=role==='hider'?'hider':'seeker';
  return {
    role:safeRole,
    radius:Math.max(50,Math.min(2000,Number(radius)||500)),
    self:{id:'self',role:safeRole,x:50,y:50,label:'Du'},
    actors:TEAMMATES[safeRole].map(actor=>({...actor})),
    inventory:eligibleSkills(DEFAULT_SETTINGS,safeRole),
    effects:{}, traps:[{id:'practice-trap',x:53,y:52,expiresAt:Date.now()+300000}], decoys:[], restrictedZones:[], forcedHiders:[],
    score:120, timeExchangesUsed:0, matchSeconds:Math.max(300,Number(DEFAULT_SETTINGS.gameDuration)||1200),
    log:['Trainingsrunde bereit. Wähle eine Fähigkeit zum Ausprobieren.'],
    placementPending:false, targetReady:false, caught:false, shieldBlocks:0
  };
}

export function setSkillLabRadius(session,radius) {
  session.radius=Math.max(50,Math.min(2000,Math.round(Number(radius)||500)));
  return session;
}

export function queueSkillLabPlacement(session) {
  if(session.role!=='hider'||!session.inventory.includes('decoy')) return false;
  session.placementPending=true;
  session.log.unshift('Tippe in den Spielkreis, um den Täusch-Ping zu platzieren.');
  session.log=session.log.slice(0,8);
  return true;
}

export function activateSkillLabSkill(session,skillId,{x,y}={}) {
  const tuning=skillTuning(skillId,session.radius);
  if(!tuning||tuning.side!==session.role) return {ok:false,reason:'Diese Fähigkeit gehört zur anderen Rolle.'};
  if(!session.inventory.includes(skillId)) return {ok:false,reason:'Diese Fähigkeit wurde in dieser Trainingsrunde bereits eingesetzt.'};
  if(skillId==='decoy'&&(!Number.isFinite(x)||!Number.isFinite(y))) return {ok:false,needsPlacement:true,reason:'Wähle den Marker auf der Karte.'};

  const timestamp=Date.now();
  const effect=(duration)=>timestamp+Math.max(0,duration)*1000;
  const expiresAt=effect(tuning.duration);
  if(skillId==='sonar') {
    session.effects.sonarUntil=expiresAt;
    session.effects.sonarTargets=session.actors.filter(a=>a.role==='hider'&&!fresh(session.effects.ghostUntil,timestamp)).map(a=>a.id);
  } else if(skillId==='tracker'||skillId==='compass') {
    const hiders=session.actors.filter(a=>a.role==='hider'&&!fresh(session.effects.ghostUntil,timestamp));
    hiders.sort((a,b)=>pointDistance(session.self,a,session.radius)-pointDistance(session.self,b,session.radius));
    const target=skillId==='compass'?hiders[hiders.length-1]:hiders[0];
    session.effects.trackerUntil=effect(tuning.duration||60);
    session.effects.trackerTarget=target?.id||null;
    if(skillId==='compass') session.effects.compassUntil=expiresAt;
  } else if(skillId==='jammer') session.effects.jammerUntil=expiresAt;
  else if(skillId==='sprint') session.effects.sprintUntil=expiresAt;
  else if(skillId==='sweeper') {
    const before=session.traps.length;
    session.traps=session.traps.filter(trap=>pointDistance(session.self,trap,session.radius)>tuning.sweepRadius);
    session.effects.lastSweepCount=before-session.traps.length;
  } else if(skillId==='ghost') session.effects.ghostUntil=expiresAt;
  else if(skillId==='decoy') {
    const point={x:Math.max(8,Math.min(92,x)),y:Math.max(8,Math.min(92,y))};
    if(pointDistance({x:50,y:50},point,session.radius)>tuning.decoyRange) return {ok:false,reason:`Der Marker liegt außerhalb deiner Reichweite von ${tuning.decoyRange} m.`};
    session.decoys.push({id:`decoy-${timestamp}`,...point,expiresAt});
    session.placementPending=false;
  } else if(skillId==='trap') session.traps.push({id:`trap-${timestamp}`,x:session.self.x,y:session.self.y,expiresAt:effect(tuning.duration*6),radius:tuning.trapRadius});
  else if(skillId==='shield') session.effects.shield=true;
  else if(skillId==='seekerradar') session.effects.seekerradarUntil=expiresAt;
  else if(skillId==='silent') session.effects.silentUntil=expiresAt;
  else if(skillId==='closecall') {
    const seeker=session.actors.filter(actor=>actor.role==='seeker').sort((a,b)=>pointDistance(session.self,a,session.radius)-pointDistance(session.self,b,session.radius))[0];
    const distance=seeker?pointDistance(session.self,seeker,session.radius):Infinity;
    if(distance>20) return {ok:false,reason:`Trainings-Seeker ist ${Math.round(distance)} m entfernt. Stelle ihn mit dem Distanzregler auf höchstens 20 m.`};
    session.effects.closecall={progressSince:timestamp,lastProofAt:timestamp,expiresAt:timestamp+90000,duration:tuning.duration*1000,radius:20};
  } else if(skillId==='freeze') {
    const seeker=session.actors.filter(actor=>actor.role==='seeker').sort((a,b)=>pointDistance(session.self,a,session.radius)-pointDistance(session.self,b,session.radius))[0];
    const distance=seeker?pointDistance(session.self,seeker,session.radius):Infinity;
    if(distance>tuning.freezeRadius) return {ok:false,reason:`Trainings-Seeker ist ${Math.round(distance)} m entfernt. Stelle ihn mit dem Distanzregler auf höchstens ${tuning.freezeRadius} m.`};
    session.effects.seekerFrozenUntil=effect(tuning.duration); session.effects.frozenSeekerId=seeker.id;
  }

  session.inventory=session.inventory.filter(id=>id!==skillId);
  const resultText=skillId==='sweeper'
    ? `${tuning.short}: ${session.effects.lastSweepCount} Trainingsfalle(n) im Radius von ${tuning.sweepRadius} m entfernt.`
    : skillId==='decoy'
      ? `${tuning.short}: Täusch-Ping gesetzt, sichtbar für ${tuning.duration} Sekunden.`
      : skillId==='trap'
        ? `${tuning.short}: Falle mit ${tuning.trapRadius} m Wirkungsradius platziert.`
        : skillId==='closecall'
          ? `${tuning.short}: bleib ${tuning.duration} Sekunden innerhalb von 20 m und erhalte ${tacticalTuning({radius:session.radius}).closeCallReward} Punkte.`
          : skillId==='freeze'
            ? `${tuning.short}: Trainings-Seeker für ${tuning.duration} Sekunden eingefroren.`
        : skillId==='shield'
          ? `${tuning.short}: bereit, den nächsten Fangversuch abzuwehren.`
          : `${tuning.short}: aktiv für ${tuning.duration} Sekunden.`;
  session.log.unshift(resultText);
  session.log=session.log.slice(0,8);
  return {ok:true,tuning,message:resultText};
}

export function activateSkillLabTactical(session,ability,{mode='random',seconds=30,targetId=null,x=50,y=50}={}) {
  if(session.role!=='seeker') return {ok:false,reason:'Diese Punkte-Fähigkeiten gehören zum Suchteam.'};
  const tuning=tacticalTuning({radius:session.radius});
  if(ability==='zone') {
    if(session.score<tuning.zoneCost) return {ok:false,reason:`Die Sperrzone kostet ${tuning.zoneCost} Punkte.`};
    const diameter=tuning.zoneRadius*2*42/session.radius;
    session.restrictedZones.push({id:`zone-${Date.now()}`,x,y,diameter,radius:tuning.zoneRadius});
    session.score-=tuning.zoneCost;
    session.log.unshift(`Trainings-Sperrzone gesetzt · ${tuning.zoneRadius} m · −${tuning.zoneCost} Punkte.`);
  } else if(ability==='relocate') {
    let targets=[];
    const hiders=session.actors.filter(actor=>actor.role==='hider');
    if(mode==='one') targets=hiders.filter(actor=>actor.id===targetId).slice(0,1);
    else if(mode==='all') targets=hiders;
    else if(mode==='random'&&hiders.length) targets=[hiders[Math.floor(Math.random()*hiders.length)]];
    if(!targets.length) return {ok:false,reason:'Kein Trainings-Hider ausgewählt.'};
    const cost=tuning.relocationCost(mode,targets.length);
    if(session.score<cost) return {ok:false,reason:`Umpositionieren kostet ${cost} Punkte.`};
    for(const actor of targets) {
      const from={x:actor.x,y:actor.y};
      session.forcedHiders.push({id:actor.id,from,minimumMeters:tuning.relocateDistance});
      actor.x=Math.min(92,actor.x+(tuning.relocateDistance+10)*42/session.radius);
    }
    session.score-=cost;
    session.log.unshift(`${targets.length} Trainings-Hider müssen mindestens ${tuning.relocateDistance} m weiterziehen · −${cost} Punkte.`);
  } else if(ability==='exchangeTime') {
    const value=Number(seconds),reward=tuning.exchangeReward(value);
    if(![30,60,90].includes(value)||session.timeExchangesUsed>=3||session.matchSeconds-value<300) return {ok:false,reason:'Der Zeit-Tausch würde die fünf Minuten Mindestspielzeit unterschreiten oder das Rundenlimit überschreiten.'};
    session.matchSeconds-=value;
    session.score+=reward;
    session.timeExchangesUsed+=1;
    session.log.unshift(`${value} Sekunden gegen +${reward} Trainingspunkte getauscht.`);
  } else return {ok:false,reason:'Unbekannte Trainingsfähigkeit.'};
  session.log=session.log.slice(0,8);
  return {ok:true,tuning,score:session.score};
}

export function moveSkillLabTarget(session,distanceMeters) {
  const target=session.actors.find(actor=>actor.role===(session.role==='seeker'?'hider':'seeker'));
  if(!target) return false;
  const boundedDistance=Math.min(session.radius,Math.max(0,Number(distanceMeters)||0));
  const offset=boundedDistance*42/session.radius;
  target.x=Math.min(92,session.self.x+offset);
  target.y=session.self.y;
  session.targetReady=true; session.caught=false;
  session.log.unshift(`Trainingsgegner auf ${boundedDistance} m gesetzt.`); session.log=session.log.slice(0,8);
  return true;
}

export function attemptSkillLabCatch(session) {
  const opponentRole=session.role==='seeker'?'hider':'seeker';
  const opponent=session.actors.find(actor=>actor.role===opponentRole);
  if(!opponent) return {ok:false,message:'Kein Trainingsziel vorhanden.'};
  const distance=pointDistance(session.self,opponent,session.radius);
  if(session.role==='seeker') {
    if(distance>8.000001) {
      const message=`Außer Reichweite: ${distance.toFixed(1)} m. Maximal 8 m.`;
      session.log.unshift(message); session.log=session.log.slice(0,8);
      return {ok:false,distance,message};
    }
    session.caught=true;
    const message=`Trainingsfang erfolgreich bei ${distance.toFixed(1)} m.`;
    session.log.unshift(message); session.log=session.log.slice(0,8);
    return {ok:true,distance,message};
  }
  if(distance>8.000001) {
    const message=`Fangversuch außerhalb von 8 m (${distance.toFixed(1)} m).`;
    session.log.unshift(message); session.log=session.log.slice(0,8);
    return {ok:false,distance,message};
  }
  if(session.effects.shield) {
    session.effects.shield=false; session.shieldBlocks+=1;
    const message='Schild hat den Fangversuch innerhalb von 8 m abgewehrt.';
    session.log.unshift(message); session.log=session.log.slice(0,8);
    return {ok:true,blocked:true,distance,message};
  }
  session.caught=true;
  const message='Trainingsfang erfolgreich. Setze vor dem nächsten Versuch dein Schild ein.';
  session.log.unshift(message); session.log=session.log.slice(0,8);
  return {ok:true,caught:true,distance,message};
}

export function skillLabSnapshot(session,timestamp=Date.now()) {
  const challenge=session.effects.closecall;
  if(challenge) {
    const seeker=session.actors.filter(actor=>actor.role==='seeker').sort((a,b)=>pointDistance(session.self,a,session.radius)-pointDistance(session.self,b,session.radius))[0];
    const close=seeker&&pointDistance(session.self,seeker,session.radius)<=challenge.radius;
    if(timestamp>challenge.expiresAt) {
      delete session.effects.closecall;
      session.log.unshift('Mutprobe abgelaufen. Es wurden keine Punkte vergeben.'); session.log=session.log.slice(0,8);
    } else if(!close) challenge.progressSince=0;
    else {
      if(!challenge.progressSince || timestamp-challenge.lastProofAt>12000) challenge.progressSince=timestamp;
      challenge.lastProofAt=timestamp;
      if(timestamp-challenge.progressSince>=challenge.duration) {
        const reward=tacticalTuning({radius:session.radius}).closeCallReward;
        session.score=(session.score||0)+reward;
        delete session.effects.closecall;
        session.log.unshift(`Mutprobe geschafft: +${reward} Punkte.`); session.log=session.log.slice(0,8);
      }
    }
  }
  const jammer=fresh(session.effects.jammerUntil,timestamp);
  const sonar=fresh(session.effects.sonarUntil,timestamp);
  const tracker=fresh(session.effects.trackerUntil,timestamp);
  const seekerRadar=fresh(session.effects.seekerradarUntil,timestamp)&&!jammer;
  const actors=session.actors.filter(actor=>{
    if(actor.role==='hider'&&session.role==='seeker') return (sonar&&session.effects.sonarTargets?.includes(actor.id)&&!fresh(session.effects.ghostUntil,timestamp))||(tracker&&session.effects.trackerTarget===actor.id)||(session.targetReady&&actor.id===session.actors.find(a=>a.role==='hider')?.id);
    if(actor.role==='seeker'&&session.role==='hider') return seekerRadar||(session.targetReady&&actor.id===session.actors.find(a=>a.role==='seeker')?.id);
    return actor.role===session.role;
  }).map(actor=>({...actor,tracked:tracker&&session.effects.trackerTarget===actor.id,frozen:session.effects.frozenSeekerId===actor.id&&fresh(session.effects.seekerFrozenUntil,timestamp)}));
  const effects=Object.entries(session.effects).filter(([key,value])=>key.endsWith('Until')&&fresh(value,timestamp)).map(([key,value])=>({key,remainingSeconds:Math.ceil((value-timestamp)/1000)}));
  if(session.effects.closecall) effects.push({key:'closecall',remainingSeconds:Math.max(0,Math.ceil((session.effects.closecall.duration-(timestamp-session.effects.closecall.progressSince))/1000))});
  return {actors,traps:session.traps.filter(t=>fresh(t.expiresAt,timestamp)),decoys:session.decoys.filter(d=>fresh(d.expiresAt,timestamp)),restrictedZones:[...session.restrictedZones],forcedHiders:[...session.forcedHiders],effects,jammed:jammer,inventory:[...session.inventory],placementPending:session.placementPending,caught:session.caught,score:Number(session.score)||0,timeExchangesUsed:session.timeExchangesUsed,matchSeconds:session.matchSeconds,log:[...session.log]};
}
