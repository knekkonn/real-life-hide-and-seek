import { evaluateZone, makeLocationSample, validPoint } from './gps.js';
import { compressRoundPhoto } from './photos.js';
import { initBackend, getBackendMode, getPlayerUid, getAccountInfo, registerAccount, signInAccount, signOutAccount, sendAccountPasswordReset, getAccountProfile, saveAccountProfile, enableProtectedTestMode, createRoom, getRoom, mutateRoom, subscribeRoom, subscribeConnection, workerCommand, fetchRoundPhoto } from './backend.js';
import { MAX_PLAYERS, MIN_PLAYERS } from './config.js';
import { COSMETIC_IDS } from './profile.js';
import { SKILLS, SKILL_IDS, DEFAULT_SETTINGS, skillTuning, tacticalTuning } from './skills.js';
import { createSkillLabSession, setSkillLabRadius, queueSkillLabPlacement, activateSkillLabSkill, activateSkillLabTactical, moveSkillLabTarget, attemptSkillLabCatch, skillLabSnapshot } from './skill-lab.js';
import { TASK_LAB_CATALOG, createTaskLabSession, startTaskLabTask, setTaskLabDistance, advanceTaskLabStay, advanceTaskLabCloseCall, completeTaskLabTask, cancelTaskLabTask, taskLabSnapshot } from './task-lab.js';
import {
  createRoomData, addPlayerToRoom, updateSettings, startCountdown, advanceExpiredPhase,
  maybePayTimeReward, updatePlayerLocation, requestCatch, buySkill,
  activateSkill, collectItemBox, completeTask, leaveRoom
} from './game-service.js';
import { updateLobbyMap, resetLobbyMap, initMap, updateMap, centerMap, invalidateMapSize, resetMap, drawRoundTracks, clearRoundTracks, beginMapPlacement, cancelMapPlacement } from './map.js';
import { clamp, now, formatTime, escapeHTML, randomCode, distanceMeters, Sound, haptic, setSoundEnabled } from './utils.js';

const $ = (id) => document.getElementById(id);
const state = {
  uid:null, playerName:'', roomCode:null, room:null, profile:null, testModeExpiresAt:0, skillLabSession:null, taskLabSession:null, skillLabTimer:null, unsubscribe:null, connected:true,
  ownLocation:null, watchId:null, gpsPending:false, gpsAuthorized:false, gpsWatchCallbacks:null, gpsSyncStatus:'idle', lastLocationWrite:0,
  lastAnnouncementId:null, lastSeekerSideAnnouncementId:null, subscriptionStartedAt:0, seenCatchRequest:null,
  revealDismissedPhase:null, lastCountdownSecond:null, currentTab:'mapTab', lastCelebratedRoundId:null, lastTracksRoundId:null,
  audioOn:true, tickHandle:null, passiveRewardAt:0, shakeHandler:null, shakeTimer:null,
  shakeCount:0, shakeTarget:10, challengeDone:false, pendingTimer:null,
  roundPhotoUrls:new Map(), roundPhotoLoads:new Set(), roundPhotoFailures:new Map()
};

const SKILL_ICONS = { sonar:'◉',tracker:'⌖',jammer:'ϟ',sprint:'⚡',sweeper:'⌁',compass:'➤',ghost:'✧',decoy:'◈',trap:'⌗',shield:'⬡',seekerradar:'◎',silent:'♧',freeze:'❄' };
const PHASE_LABELS = { lobby:'LOBBY READY',countdown:'SYNC COUNTDOWN',reveal:'IDENTITY REVEAL',hide:'HIDE PHASE',playing:'LIVE MATCH',finished:'MISSION COMPLETE',closed:'ROOM CLOSED' };

function setConnectionBadge() {
  const badge = $('connectionBadge');
  const span = badge.querySelector('span');
  badge.classList.toggle('is-connected', state.connected && ['firebase','worker'].includes(getBackendMode()));
  badge.classList.toggle('is-error', !state.connected);
  if (['firebase','worker'].includes(getBackendMode())) span.textContent = state.connected ? (getBackendMode() === 'worker' ? 'BACKEND LIVE' : 'FIREBASE TEST') : 'RECONNECTING';
  else span.textContent = 'FIREBASE NICHT VERBUNDEN';
}

async function refreshAccountPanel() {
  const account=getAccountInfo();
  const linked=Boolean(account&&!account.isAnonymous);
  $('accountGuestForm')?.classList.toggle('hidden',linked);
  $('accountProfile')?.classList.toggle('hidden',!linked);
  if(!linked) {
    if($('accountStatus')) $('accountStatus').textContent=account?'Gastkonto · Spielstände dieses Geräts sind nicht kontoübergreifend gespeichert.':'Backend nicht verbunden.';
    return;
  }
  try {
    state.profile=await getAccountProfile();
    state.audioOn=state.profile.soundEnabled!==false; setSoundEnabled(state.audioOn); syncAudioControls();
    $('accountStatus').textContent=`Konto verbunden: ${account.email||'E-Mail-Konto'}`;
    $('profileName').value=state.profile.displayName||state.playerName||$('playerName').value||'';
    $('profileCosmetic').value=COSMETIC_IDS.includes(state.profile.cosmeticId)?state.profile.cosmeticId:'lime';
    if(!state.roomCode && state.profile.displayName && !$('playerName').value) $('playerName').value=state.profile.displayName;
  } catch(error) {
    $('accountStatus').textContent=error.message||'Profil konnte nicht geladen werden.';
    $('profileName').value=state.playerName||$('playerName').value||'';
  }
}

function validAccountForm() {
  const email=$('accountEmail').value.trim(),password=$('accountPassword').value;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) { toast('E-Mail prüfen','Bitte eine gültige E-Mail-Adresse eingeben.','warn'); return null; }
  if(password.length<8||password.length>128) { toast('Passwort prüfen','Das Passwort muss 8 bis 128 Zeichen lang sein.','warn'); return null; }
  return {email,password};
}

async function createAccountFromForm() {
  const credentials=validAccountForm(); if(!credentials) return;
  try {
    const account=await registerAccount(credentials.email,credentials.password); state.uid=account.uid;
    const displayName=($('profileName').value||$('playerName').value||state.playerName||'NIGHTHAWK').trim();
    const profile=await saveAccountProfile({displayName,cosmeticId:$('profileCosmetic').value||'lime',soundEnabled:state.audioOn,hapticsEnabled:true});
    state.profile=profile;
    await refreshAccountPanel();
    toast('Konto erstellt','Name und Avatar-Optik werden sicher mit deinem Konto synchronisiert.','success');
  } catch(error) { toast('Konto konnte nicht erstellt werden',error.message||'Bitte E-Mail und Passwort prüfen.','warn',6000); }
}

async function loginFromForm() {
  const credentials=validAccountForm(); if(!credentials) return;
  if(state.roomCode) { toast('Runde zuerst verlassen','Melde dich an, bevor du einer Runde beitrittst.','warn'); return; }
  try {
    const account=await signInAccount(credentials.email,credentials.password); state.uid=account.uid;
    await refreshAccountPanel();
    toast('Angemeldet','Dein Profil ist auf diesem Gerät verfügbar.','success');
  } catch(error) { toast('Anmeldung fehlgeschlagen',error.message||'E-Mail oder Passwort stimmen nicht.','warn',6000); }
}

async function resetAccountPassword() {
  const email=$('accountEmail').value.trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('E-Mail fehlt','Gib zuerst die E-Mail deines Kontos ein.','warn'); return; }
  try { await sendAccountPasswordReset(email); toast('E-Mail versendet','Wenn für diese Adresse ein Konto besteht, ist eine Anleitung zum Zurücksetzen unterwegs.','success',6000); }
  catch(error) { toast('Zurücksetzen nicht möglich',error.message||'Bitte später erneut versuchen.','warn'); }
}

async function saveProfileFromForm() {
  if(getAccountInfo()?.isAnonymous!==false) { toast('Konto erforderlich','Melde dich mit deinem Konto an, um Profilwerte zu speichern.','warn'); return; }
  const displayName=$('profileName').value.trim().replace(/\s+/g,' '),cosmeticId=$('profileCosmetic').value;
  if(displayName.length<2||displayName.length>18||! /^[\p{L}\p{N}_ -]+$/u.test(displayName)||!COSMETIC_IDS.includes(cosmeticId)) { toast('Profil prüfen','Name (2–18 erlaubte Zeichen) oder Optik ungültig.','warn'); return; }
  try {
    state.profile=await saveAccountProfile({displayName,cosmeticId,soundEnabled:state.audioOn,hapticsEnabled:true});
    if(state.roomCode) await workerCommand(state.roomCode,'syncProfile',{displayName,cosmeticId});
    if(!state.roomCode) $('playerName').value=displayName;
    toast('Profil gespeichert','Dein Codename und Cosmetic sind mit deinem Konto verknüpft.','success');
    if(state.room) renderGame(state.room);
  } catch(error) { toast('Profil nicht gespeichert',error.message||'Backend-Verbindung prüfen.','warn'); }
}

async function signOutFromForm() {
  if(state.roomCode) { toast('Runde zuerst verlassen','Verlasse zuerst den Raum, damit deine aktive Teilnahme erhalten bleibt.','warn'); return; }
  try { const account=await signOutAccount(); state.uid=account?.uid||null; state.profile=null; await refreshAccountPanel(); toast('Abgemeldet','Du kannst weiterhin als Gast spielen.','info'); }
  catch(error) { toast('Abmeldung fehlgeschlagen',error.message||'Bitte erneut versuchen.','warn'); }
}

async function unlockTestMode() {
  const account=getAccountInfo();
  if(!account||account.isAnonymous) { toast('Konto erforderlich','Der Testmodus ist nur für angemeldete Konten freigeschaltet.','warn'); return; }
  const code=$('testModeCode').value; if(!code) { toast('Code fehlt','Gib den geschützten Test-Zugangscode ein.','warn'); return; }
  try {
    await enableProtectedTestMode(code); state.testModeExpiresAt=now()+30*60*1000; $('testModeCode').value='';
    const diagnostics=[];
    diagnostics.push(['Konto',true,'Angemeldet']);
    diagnostics.push(['Worker / D1',getBackendMode()==='worker',getBackendMode()==='worker'?'Konfiguriert':'Worker-Backend fehlt']);
    diagnostics.push(['Sicherer Kontext',window.isSecureContext,'HTTPS erforderlich für GPS und Service Worker']);
    diagnostics.push(['GPS',Boolean(navigator.geolocation),navigator.geolocation?'Browser unterstützt GPS':'GPS-API fehlt']);
    let storage=false; try { const key='hs-test-'+Math.random(); localStorage.setItem(key,'1'); storage=localStorage.getItem(key)==='1'; localStorage.removeItem(key); } catch {}
    diagnostics.push(['Lokaler Speicher',storage,storage?'verfügbar':'Browser-Speicher blockiert']);
    const start=performance.now(); try { await getAccountProfile(); diagnostics.push(['Profil-API',true,`Antwort in ${Math.round(performance.now()-start)} ms`]); } catch(error) { diagnostics.push(['Profil-API',false,error.message]); }
    $('testDiagnostics').innerHTML=diagnostics.map(([label,ok,detail])=>`<p data-ok="${ok}"><strong>${escapeHTML(label)}:</strong> ${escapeHTML(detail)}</p>`).join('')+`<p>Spiel- und Testmodus für 30 Minuten freigeschaltet.</p>`;
    $('testDiagnostics').classList.remove('hidden');
    $('skillLab').classList.remove('hidden');
    resetSkillLab('seeker');
    clearInterval(state.skillLabTimer);
    state.skillLabTimer=window.setInterval(renderSkillLab,1000);
    toast('Trainingsmodus aktiv','Probiere beide Rollen und alle Fähigkeiten in einer isolierten Runde aus.','success');
  } catch(error) { toast('Testmodus gesperrt',error.message||'Zugangscode prüfen.','warn'); }
}

function resetSkillLab(role=state.skillLabSession?.role||'seeker') {
  const radius=Number($('skillLabRadius')?.value)||500;
  state.skillLabSession=createSkillLabSession(role,radius);
  state.taskLabSession=createTaskLabSession(role);
  if($('skillLabCatchDistance')) $('skillLabCatchDistance').value='6';
  renderSkillLab();
}

function renderSkillLab() {
  const session=state.skillLabSession;
  if(!session||!$('skillLab')||$('skillLab').classList.contains('hidden')) return;
  const timeLeft=Math.max(0,Math.ceil((state.testModeExpiresAt-now())/1000));
  if(timeLeft===0) {
    state.skillLabSession=null;
    state.taskLabSession=null;
    clearInterval(state.skillLabTimer); state.skillLabTimer=null;
    $('skillLab').classList.add('hidden'); $('testDiagnostics').classList.add('hidden');
    toast('Testmodus beendet','Gib den Zugangscode erneut ein, um weiterzutesten.','info');
    return;
  }
  const snapshot=skillLabSnapshot(session,now());
  $('skillLabTime').textContent=`${Math.floor(timeLeft/60)}:${String(timeLeft%60).padStart(2,'0')} MIN`;
  if(document.activeElement!==$('skillLabRadius')) $('skillLabRadius').value=String(session.radius);
  document.querySelectorAll('[data-lab-role]').forEach(button=>{
    const active=button.dataset.labRole===session.role;
    button.classList.toggle('is-active',active); button.setAttribute('aria-pressed',String(active));
  });
  $('skillLabSkillCount').textContent=`${snapshot.inventory.length} bereit · ${snapshot.score} P`;
  const actors=[session.self,...snapshot.actors];
  const marker=(actor)=>`<div class="skill-lab-marker ${actor.id==='self'?'self':actor.role}${actor.tracked?' is-tracked':''}${actor.frozen?' is-frozen':''}${actor.id==='self'&&session.effects.shield?' is-shielded':''}${actor.id==='self'&&session.effects.ghostUntil>now()?' is-ghosted':''}${actor.id==='self'&&session.effects.silentUntil>now()?' is-silent':''}" style="left:${actor.x}%;top:${actor.y}%" aria-label="${escapeHTML(actor.label)}"><span>${actor.id==='self'?'DU':actor.role==='seeker'?'S':'H'}</span><small>${escapeHTML(actor.label)}</small></div>`;
  const trapMarkers=snapshot.traps.map(trap=>`<div class="skill-lab-marker trap" style="left:${trap.x}%;top:${trap.y}%" aria-label="Trainingsfalle"><span>⌗</span><small>Falle</small></div>`).join('');
  const decoyMarkers=snapshot.decoys.map(decoy=>`<div class="skill-lab-marker decoy" style="left:${decoy.x}%;top:${decoy.y}%" aria-label="Täusch-Ping"><span>◈</span><small>Falsches Signal</small></div>`).join('');
  const restrictedMarkers=(snapshot.restrictedZones||[]).map(zone=>`<div class="skill-lab-restriction" style="left:${zone.x-zone.diameter/2}%;top:${zone.y-zone.diameter/2}%;width:${zone.diameter}%;height:${zone.diameter}%" aria-label="Trainings-Sperrzone"></div>`).join('');
  $('skillLabMap').classList.toggle('is-placing',snapshot.placementPending);
  $('skillLabMap').classList.toggle('is-jammed',snapshot.jammed);
  $('skillLabMap').classList.toggle('is-sprinting',session.effects.sprintUntil>now());
  $('skillLabCenterDecoyBtn').classList.toggle('hidden',!snapshot.placementPending);
  $('skillLabMap').innerHTML=`<div class="skill-lab-grid"></div><div class="skill-lab-zone" aria-hidden="true"></div><div class="skill-lab-center" aria-hidden="true">◎</div>${restrictedMarkers}${actors.map(marker).join('')}${trapMarkers}${decoyMarkers}${snapshot.jammed?'<div class="skill-lab-feedback">RADAR STATIC</div>':''}${session.effects.sprintUntil>now()?'<div class="skill-lab-feedback sprint">SPRINT ALARM · BEWEGUNG ERKANNT</div>':''}${snapshot.caught?'<div class="skill-lab-result">TRAININGSFANG</div>':''}${snapshot.placementPending?'<div class="skill-lab-place-prompt">Tippe in den Spielkreis<br><small>Zum Platzieren des Täusch-Pings</small></div>':''}`;
  const active=snapshot.effects.map(effect=>{
    const names={sonarUntil:'Sonar',trackerUntil:'Tracker',compassUntil:'Kompass',jammerUntil:'Jammer',sprintUntil:'Sprint-Alarm',ghostUntil:'Geist-Modus',seekerradarUntil:'Seeker-Radar',silentUntil:'Leise Sohlen',seekerFrozenUntil:'Seeker eingefroren'};
    return `${names[effect.key]||'Effekt'} · ${effect.remainingSeconds}s`;
  });
  if(session.effects.shield) active.push('Schild bereit');
  if(session.effects.lastSweepCount!==undefined) active.push(`Fallen geräumt · ${session.effects.lastSweepCount}`);
  const latest=snapshot.log[0]||'Fähigkeit auswählen oder Fangradius testen.';
  const hint=snapshot.placementPending?'Tippe auf einen Punkt innerhalb der Zone, um den Marker zu setzen.':snapshot.jammed?`${latest} · Jammer aktiv, Seeker-Radar blockiert.`:active.length?`${latest} · Aktiv: ${active.join(' · ')}`:latest;
  $('skillLabHint').textContent=hint;
  $('skillLabHint').dataset.result=/außer reichweite|außerhalb von 8 m/i.test(hint)?'error':/erfolgreich|abgewehrt|gesetzt|entfernt|aktiv/i.test(hint)?'success':'';
  $('skillLabCatchControls').classList.toggle('is-hider-lab',session.role==='hider');
  $('skillLabCatchBtn').textContent=session.role==='seeker'?'Fangversuch testen':'Seeker-Fangversuch testen';
  const roleSkills=SKILL_IDS.filter(id=>SKILLS[id].side===session.role);
  const skillCards=roleSkills.map(id=>{
    const skill=skillTuning(id,session.radius),ready=session.inventory.includes(id),pending=session.placementPending&&id==='decoy';
    const extra=id==='sweeper'?`Räumradius ${skill.sweepRadius} m`:id==='decoy'?`Platzierung bis ${skill.decoyRange} m`:id==='trap'?`Wirkung ${skill.trapRadius} m`:skill.duration?`${skill.duration} Sek.`:'Sofort';
    const action=id==='decoy'?'Punkt wählen':ready?'Jetzt einsetzen':'Eingesetzt';
    return `<article class="skill-lab-card${ready?'':' is-used'}"><div class="skill-lab-card-top"><span class="skill-lab-icon">${escapeHTML(skill.icon)}</span><span class="tiny-label">${escapeHTML(extra)}</span></div><h4>${escapeHTML(skill.name)}</h4><p>${escapeHTML(skill.description)}</p><button type="button" class="button ${ready?'button-secondary':''}" data-lab-skill="${id}" ${ready?'':'disabled'}>${pending?'Jetzt auf der Karte platzieren':action}</button></article>`;
  }).join('');
  const tuning=tacticalTuning({radius:session.radius});
  const tacticalCards=session.role==='seeker'?`<article class="skill-lab-card"><div class="skill-lab-card-top"><span class="skill-lab-icon">⊘</span><span class="tiny-label">${tuning.zoneCost} P · ${tuning.zoneRadius} M</span></div><h4>Sperrzone</h4><p>Setze eine markierte Trainingszone auf die Karte und teste Radius sowie Punktkosten.</p><button type="button" class="button button-secondary" data-lab-tactical="zone">Sperrzone testen</button></article><article class="skill-lab-card"><div class="skill-lab-card-top"><span class="skill-lab-icon">⇄</span><span class="tiny-label">ZEIT GEGEN PUNKTE</span></div><h4>Zeit tauschen</h4><p>Verkürze die Trainingsrunde um 30 Sekunden und erhalte ${tuning.exchangeReward(30)} Punkte.</p><button type="button" class="button button-secondary" data-lab-tactical="exchangeTime" data-lab-seconds="30">30 s eintauschen</button></article><article class="skill-lab-card"><div class="skill-lab-card-top"><span class="skill-lab-icon">↗</span><span class="tiny-label">ABSTAND ${tuning.relocateDistance} M</span></div><h4>Hider umpositionieren</h4><p>Wähle einen, zufälligen oder alle Trainings-Hider. Die Kosten skalieren mit der Anzahl.</p><button type="button" class="button button-secondary" data-lab-tactical="relocate" data-lab-mode="random">Zufälligen Hider testen · ${tuning.relocationCost('random')} P</button></article>`:'';
  $('skillLabSkills').innerHTML=skillCards+tacticalCards;
  renderTaskLab();
  const labLog=[...(state.taskLabSession?.log||[]),...snapshot.log].slice(0,8);
  $('skillLabLog').innerHTML=labLog.length?labLog.map(line=>`<p>${escapeHTML(line)}</p>`).join(''):'<p>Das Protokoll ist leer.</p>';
}

function renderTaskLab() {
  const root=$('skillLabTasks'),session=state.taskLabSession;
  if(!root||!session) return;
  const snapshot=taskLabSnapshot(session,now());
  $('skillLabTaskSummary').textContent=`${snapshot.completed} geschafft · ${snapshot.failed} fehlgeschlagen · ${snapshot.credits} Test-Credits · ${snapshot.score} Testpunkte`;
  const active=snapshot.active;
  const renderKey=JSON.stringify(snapshot);
  if(root.dataset.renderKey===renderKey || root.contains(document.activeElement)&&document.activeElement.matches('input')) return;
  root.dataset.renderKey=renderKey;
  root.innerHTML=TASK_LAB_CATALOG[session.role].map(task=>{
    const selected=active?.kind===task.kind;
    const busy=Boolean(active&&!selected),cooling=snapshot.cooldownSeconds>0;
    let controls='';
    if(selected&&task.kind==='cipher') {
      const clues=active.puzzle?.clues||[];
      controls=`<div class="skill-lab-task-challenge"><p>Der Code enthält drei verschiedene Ziffern. Noch ${active.attemptsRemaining} Versuche.</p><ul>${clues.map(clue=>`<li><strong>${clue.guess}</strong> · ${clue.exact} richtig platziert · ${clue.misplaced} an anderer Stelle</li>`).join('')}</ul><div class="skill-lab-task-input"><input data-task-answer type="text" inputmode="numeric" pattern="[0-9]{3}" maxlength="3" autocomplete="off" aria-label="Dreistelliger Testcode" placeholder="000"><button class="button button-primary" type="button" data-task-action="submit">Code prüfen</button></div></div>`;
    } else if(selected&&['visit','scan'].includes(task.kind)) {
      controls=`<div class="skill-lab-task-challenge"><p>Testziel liegt innerhalb der Spielzone. Keine Karten- oder GPS-Abfrage wird gesendet.</p><button class="button button-primary" type="button" data-task-action="arrive">${task.kind==='scan'?'Cache erreicht · Scan testen':'Ziel erreicht simulieren'}</button></div>`;
    } else if(selected&&task.kind==='stay') {
      const progress=Math.round(active.elapsed/60*100);
      controls=`<div class="skill-lab-task-challenge"><p>Simulierte Standzeit: <strong>${active.elapsed} / 60 s</strong></p><div class="relocation-progress"><i style="width:${progress}%"></i></div><div class="skill-lab-task-actions"><button class="button button-secondary" type="button" data-task-action="stay-step" ${active.elapsed>=60?'disabled':''}>+15 s simulieren</button><button class="button button-primary" type="button" data-task-action="submit" ${active.elapsed<60?'disabled':''}>Aufgabe abgeben</button></div></div>`;
    } else if(selected&&task.kind==='photo') {
      controls=`<div class="skill-lab-task-challenge"><label class="field-label" for="taskLabPhoto">Kamera oder Bild auswählen</label><input id="taskLabPhoto" data-task-photo class="modal-input" type="file" accept="image/*" capture="environment"><p data-task-photo-status role="status">Das verkleinerte Foto bleibt nur im Arbeitsspeicher dieser Trainingssitzung.</p>${active.photoData?`<img class="skill-lab-photo-preview" src="${escapeHTML(active.photoData)}" alt="Lokal verkleinertes Testfoto"><p>Haltezeit: ${active.elapsed} / 180 s · Verlassen: −15 Testpunkte.</p><button class="button button-primary" type="button" data-task-action="stay-step">+15 s am Versteck simulieren</button><button class="button button-secondary" type="button" data-task-action="gps-gap">GPS-Lücke simulieren</button>`:''}</div>`;
    } else if(selected&&task.kind==='closecall') {
      controls=`<div class="skill-lab-task-challenge"><p>Abstand zum Trainings-Seeker: 10 m · <strong>+${active.elapsed} Testpunkte</strong></p><button class="button button-primary" type="button" data-task-action="risk-step">+5 s innerhalb von 15 m simulieren</button><button class="button button-secondary" type="button" data-task-action="risk-leave">15-m-Bereich verlassen</button></div>`;
    } else if(selected&&task.kind==='proximity') {
      controls=`<div class="skill-lab-task-challenge"><label class="field-label" for="taskLabDistance">Simulierter Abstand zum Hider</label><div class="skill-lab-task-input"><input id="taskLabDistance" data-task-distance type="number" inputmode="decimal" min="0" max="2000" step="1" value="${active.distanceMeters}"><span>m</span><button class="button button-primary" type="button" data-task-action="submit" ${active.distanceMeters>10?'disabled':''}>Nähe bestätigen</button></div><p>${active.distanceMeters<=10?'Im 10-m-Suchradius.':'Auf 10 m herangehen, um den Test abzuschließen.'}</p></div>`;
    }
    const action=selected?`<button class="text-button skill-lab-task-cancel" type="button" data-task-action="cancel">Test abbrechen</button>`:`<button class="button button-secondary" type="button" data-task-start="${task.kind}" ${busy||cooling||task.kind==='closecall'&&snapshot.closeCallUsed?'disabled':''}>${task.kind==='closecall'&&snapshot.closeCallUsed?'In dieser Test-Runde benutzt':cooling?`Cooldown ${snapshot.cooldownSeconds} s`:busy?'Andere Aufgabe läuft':'Aufgabe testen'}</button>`;
    return `<article class="skill-lab-task-card${selected?' is-active':''}"><div class="skill-lab-task-top"><span class="skill-lab-icon">${task.icon}</span><span class="tiny-label">${task.kind==='closecall'?'MAX. 60 SEK. · +1 TESTPUNKT / SEK.':`${task.duration} SEK. · +${task.reward} TEST-CREDITS`}</span></div><h4>${task.name}</h4><p>${task.description}</p>${selected?controls:''}${action}</article>`;
  }).join('');
}

function reportTaskLabResult(result) {
  if(!result?.ok) { $('skillLabHint').textContent=result?.reason||'Trainingsaufgabe konnte nicht abgeschlossen werden.'; $('skillLabHint').dataset.result='error'; }
  else { $('skillLabHint').textContent=result.message; $('skillLabHint').dataset.result='success'; }
  renderTaskLab();
  $('skillLabLog').innerHTML=[...(state.taskLabSession?.log||[]),...(state.skillLabSession?.log||[])].slice(0,8).map(line=>`<p>${escapeHTML(line)}</p>`).join('');
}

function startTaskLab(kind) {
  const result=startTaskLabTask(state.taskLabSession,kind,now());
  if(result.ok) {
    $('skillLabHint').textContent=`${TASK_LAB_CATALOG[state.taskLabSession.role].find(task=>task.kind===kind)?.name||'Aufgabe'} gestartet. Alle Fortschritte bleiben lokal im Testmodus.`;
    $('skillLabHint').dataset.result='';
    renderTaskLab();
    $('skillLabLog').innerHTML=[...(state.taskLabSession.log||[]),...(state.skillLabSession?.log||[])].slice(0,8).map(line=>`<p>${escapeHTML(line)}</p>`).join('');
  } else reportTaskLabResult(result);
}

function commitLabCatchDistance({attempt=false}={}) {
  const session=state.skillLabSession;if(!session) return;
  const input=$('skillLabCatchDistance');
  const max=Math.max(1,Math.floor(session.radius));
  const distance=clamp(Math.round(Number(input.value)||0),0,max);
  input.value=String(distance);
  moveSkillLabTarget(session,distance);
  if(attempt) {
    const result=attemptSkillLabCatch(session);
    $('skillLabHint').textContent=result.message;
    $('skillLabHint').dataset.result=result.ok?'success':'error';
  } else {
    $('skillLabHint').textContent=`Trainingsgegner auf ${distance} m gesetzt. ${distance<=8?'Der Fangradius ist erreicht.':'Außerhalb des 8-m-Fangradius.'}`;
    $('skillLabHint').dataset.result=distance<=8?'success':'error';
  }
  renderSkillLab();
}

function placeLabDecoy(x,y) {
  const session=state.skillLabSession;if(!session?.placementPending) return;
  if(Math.hypot(x-50,y-50)>42) {
    session.log.unshift('Der Punkt muss innerhalb des markierten Spielfelds liegen.'); session.log=session.log.slice(0,8); renderSkillLab(); return;
  }
  const result=activateSkillLabSkill(session,'decoy',{x,y});
  if(!result.ok) { session.log.unshift(result.reason); session.log=session.log.slice(0,8); }
  renderSkillLab();
}

function toast(title, message='', type='info', duration=3800) {
  const region = $('toastRegion');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const symbols = { info:'⌁',success:'✓',warn:'⚠',danger:'!',error:'!' };
  el.innerHTML = `<span class="toast-symbol">${symbols[type] || symbols.info}</span><div><strong>${escapeHTML(title)}</strong>${message ? `<p>${escapeHTML(message)}</p>` : ''}</div>`;
  region.appendChild(el);
  window.setTimeout(() => { el.style.opacity='0'; el.style.transform='translateX(8px)'; window.setTimeout(() => el.remove(), 230); }, duration);
}

function showMoment(title, detail='', type='start', icon='✦', duration=2400) {
  const overlay=$('momentOverlay'); if(!overlay) return;
  $('momentTitle').textContent=title; $('momentDetail').textContent=detail; $('momentKicker').textContent=type==='caught'?'OPERATIVE FOUND':type==='catch'?'TARGET SECURED':type==='win'?'VICTORY CONFIRMED':'MISSION UPDATE'; $('momentIcon').textContent=icon;
  overlay.classList.toggle('is-caught',type==='caught'); overlay.classList.remove('hidden');
  clearTimeout(state.momentTimer); state.momentTimer=window.setTimeout(()=>overlay.classList.add('hidden'),duration);
}

function openModal({ kicker='FIELD PROTOCOL', title='Bestätigung', body='', actions=[], closeable=true }) {
  stopShakeChallenge();
  state.modalCloseable = closeable;
  $('modalKicker').textContent = kicker;
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = body;
  $('modalActions').innerHTML = '';
  $('modalCloseBtn').classList.toggle('hidden', !closeable);
  const modalBackdrop = $('modalRoot').querySelector('.modal-backdrop');
  if (closeable) modalBackdrop.setAttribute('data-close-modal','');
  else modalBackdrop.removeAttribute('data-close-modal');
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button ${action.variant || 'button-secondary'}`;
    button.textContent = action.label;
    button.disabled = Boolean(action.disabled);
    button.addEventListener('click', async () => {
      if (action.keepOpen !== true) closeModal();
      try { await action.onClick?.(); } catch (error) { console.error(error); toast('Aktion fehlgeschlagen', error?.message || 'Bitte erneut versuchen.', 'danger'); }
    });
    $('modalActions').appendChild(button);
  }
  $('modalRoot').classList.remove('hidden');
  if (closeable) $('modalCloseBtn').focus({ preventScroll:true });
}
function closeModal() {
  $('modalRoot').classList.add('hidden');
  stopShakeChallenge();
}

function getSelf() { return state.room?.players?.[state.uid] || null; }
function activePlayers() { return Object.values(state.room?.players || {}).filter((player) => player.active); }
function currentRole() { return getSelf()?.role || 'waiting'; }
function isHost() { return state.room?.hostId === state.uid; }
function canUseGame() { return ['hide','playing'].includes(state.room?.phase) && Boolean(getSelf()?.active); }
function displayName(player) { return escapeHTML(player?.name || 'UNKNOWN'); }
function avatarCosmetic(player) { return COSMETIC_IDS.includes(player?.cosmeticId)?` cosmetic-${player.cosmeticId}`:''; }

function syncAudioControls() {
  const sound = $('soundToggle');
  if (sound) {
    sound.setAttribute('aria-pressed', String(state.audioOn));
    sound.setAttribute('aria-label', state.audioOn ? 'Soundeffekte ausschalten' : 'Soundeffekte einschalten');
    sound.title = state.audioOn ? 'Soundeffekte ausschalten' : 'Soundeffekte einschalten';
    sound.classList.toggle('is-muted', !state.audioOn);
    $('soundIcon').textContent = state.audioOn ? '♫' : '♪̸';
  }
}

async function startApp() {
  try { await initBackend(); }
  catch (error) { console.warn(error); toast('Firebase nicht verbunden', error.message + ' Erstellen oder Beitreten versucht die Verbindung erneut.', 'danger', 8000); }
  setConnectionBadge();
  syncAudioControls();
  await refreshAccountPanel();
  $('soundToggle').addEventListener('click', () => {
    state.audioOn = !state.audioOn;
    setSoundEnabled(state.audioOn);
    syncAudioControls();
    if (state.audioOn) Sound.click();
    toast('Audio', state.audioOn ? 'Soundeffekte aktiviert.' : 'Soundeffekte deaktiviert.', 'info', 1800);
  });
  setSoundEnabled(state.audioOn);
  $('entryForm').addEventListener('submit', (event) => event.preventDefault());
  $('accountCreateBtn').addEventListener('click', createAccountFromForm);
  $('accountLoginBtn').addEventListener('click', loginFromForm);
  $('accountResetBtn').addEventListener('click', resetAccountPassword);
  $('profileSaveBtn').addEventListener('click', saveProfileFromForm);
  $('accountSignOutBtn').addEventListener('click', signOutFromForm);
  $('testModeBtn').addEventListener('click', unlockTestMode);
  document.querySelectorAll('[data-lab-role]').forEach(button=>button.addEventListener('click',()=>resetSkillLab(button.dataset.labRole)));
  $('resetSkillLabBtn').addEventListener('click',()=>resetSkillLab());
  $('skillLabRadius').addEventListener('change',event=>{
    const value=clamp(50+Math.round((Number(event.target.value)-50)/25)*25,50,2000);
    event.target.value=String(value); if(state.skillLabSession) setSkillLabRadius(state.skillLabSession,value); renderSkillLab();
  });
  $('skillLabSkills').addEventListener('click',event=>{
    const tactical=event.target.closest('[data-lab-tactical]');
    if(tactical&&state.skillLabSession) {
      const session=state.skillLabSession;
      const result=activateSkillLabTactical(session,tactical.dataset.labTactical,{mode:tactical.dataset.labMode||'random',seconds:Number(tactical.dataset.labSeconds)||30,x:57,y:50});
      if(!result.ok) $('skillLabHint').textContent=result.reason;
      renderSkillLab(); return;
    }
    const button=event.target.closest('[data-lab-skill]'); if(!button||!state.skillLabSession) return;
    const skillId=button.dataset.labSkill;
    if(skillId==='decoy'&&!state.skillLabSession.placementPending) { queueSkillLabPlacement(state.skillLabSession); renderSkillLab(); return; }
    const result=activateSkillLabSkill(state.skillLabSession,skillId);
    if(!result.ok&&!result.needsPlacement) $('skillLabHint').textContent=result.reason;
    renderSkillLab();
  });
  $('skillLabTasks').addEventListener('click',async event=>{
    const session=state.taskLabSession;if(!session) return;
    const start=event.target.closest('[data-task-start]');
    if(start) { startTaskLab(start.dataset.taskStart); return; }
    const button=event.target.closest('[data-task-action]');if(!button) return;
    const task=session.active,action=button.dataset.taskAction;
    if(action==='cancel') { reportTaskLabResult(cancelTaskLabTask(session,now())); return; }
    if(action==='stay-step') { advanceTaskLabStay(session,15); if(task?.kind==='photo'&&task.elapsed>=180) reportTaskLabResult(completeTaskLabTask(session,{photoData:task.photoData},now())); else renderTaskLab(); return; }
    if(action==='gps-gap') { task.elapsed=0; session.log.unshift('GPS-Lücke: Haltezeit neu gestartet, kein Punktabzug.'); renderTaskLab(); return; }
    if(action==='risk-step') { reportTaskLabResult(advanceTaskLabCloseCall(session,5,now())); return; }
    if(action==='risk-leave') { setTaskLabDistance(session,16); reportTaskLabResult(completeTaskLabTask(session,{},now())); return; }
    if(action==='arrive') { reportTaskLabResult(completeTaskLabTask(session,{arrived:true},now())); return; }
    let proof={};
    if(task?.kind==='cipher') proof.answer=$('skillLabTasks').querySelector('[data-task-answer]')?.value||'';
    if(task?.kind==='photo') proof.photoData=task.photoData;
    reportTaskLabResult(completeTaskLabTask(session,proof,now()));
  });
  $('skillLabTasks').addEventListener('input',event=>{
    const input=event.target.closest('[data-task-distance]');if(!input||!state.taskLabSession) return;
    setTaskLabDistance(state.taskLabSession,Number(input.value));
    const nearby=state.taskLabSession.active?.distanceMeters<=10;
    const button=$('skillLabTasks').querySelector('[data-task-action="submit"]');if(button) button.disabled=!nearby;
    const note=input.closest('.skill-lab-task-challenge')?.querySelector('p:last-child');if(note) note.textContent=nearby?'Im 10-m-Suchradius.':'Auf 10 m herangehen, um den Test abzuschließen.';
  });
  $('skillLabTasks').addEventListener('change',async event=>{
    const input=event.target.closest('[data-task-photo]');if(!input||!state.taskLabSession?.active||state.taskLabSession.active.kind!=='photo') return;
    const file=input.files?.[0];if(!file) return;
    const status=$('skillLabTasks').querySelector('[data-task-photo-status]');if(status) status.textContent='Foto wird lokal verkleinert und von Metadaten bereinigt …';
    try {
      const photoData=await compressRoundPhoto(file);
      if(state.taskLabSession?.active?.kind!=='photo') return;
      state.taskLabSession.active.photoData=photoData;
      state.taskLabSession.log.unshift(`Foto lokal auf ${(photoData.length/1024).toFixed(1)} KB verkleinert; es wurde nichts hochgeladen.`);
      state.taskLabSession.log=state.taskLabSession.log.slice(0,8);
      renderTaskLab();
    } catch(error) {
      toast('Foto-Test fehlgeschlagen',error.message||'Foto konnte nicht verarbeitet werden.','warn',5000);
      reportTaskLabResult(cancelTaskLabTask(state.taskLabSession,now()));
    }
  });
  $('skillLabMap').addEventListener('click',event=>{
    const session=state.skillLabSession; if(!session?.placementPending) return;
    const rect=event.currentTarget.getBoundingClientRect();
    const x=8+(event.clientX-rect.left)/rect.width*84, y=8+(event.clientY-rect.top)/rect.height*84;
    placeLabDecoy(x,y);
  });
  $('skillLabCenterDecoyBtn').addEventListener('click',()=>placeLabDecoy(50,50));
  $('skillLabMoveTargetBtn').addEventListener('click',()=>commitLabCatchDistance());
  $('skillLabCatchBtn').addEventListener('click',()=>commitLabCatchDistance({attempt:true}));
  $('clearSkillLabLogBtn').addEventListener('click',()=>{if(state.skillLabSession)state.skillLabSession.log=[];if(state.taskLabSession)state.taskLabSession.log=[];renderSkillLab();});
  $('createRoomBtn').addEventListener('click', createLobby);
  $('joinRoomBtn').addEventListener('click', joinLobby);
  $('roomCode').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/\D/g,'').slice(0,4); });
  $('leaveBtn').addEventListener('click', confirmLeaveRoom);
  $('copyCodeBtn').addEventListener('click', copyRoomCode);
  $('startGameBtn').addEventListener('click', startGame);
  $('dismissRevealBtn').addEventListener('click', () => { state.revealDismissedPhase = state.room?.phase; $('roleReveal').classList.add('hidden'); });
  $('gpsBtn').addEventListener('click', requestGPS);
  $('mapGpsBtn').addEventListener('click', requestGPS);
  $('recenterMapBtn').addEventListener('click', () => {
    if (state.ownLocation) centerMap(state.ownLocation);
    else if (state.room?.settings?.center) centerMap(state.room.settings.center);
    else requestGPS();
  });
  $('lobbyGpsBtn').addEventListener('click', requestGPS);
  $('catchBtn').addEventListener('click', openCatchPicker);
  $('activateSkillBtn').addEventListener('click', openSkillPicker);
  $('startTaskBtn').addEventListener('click', () => startTask('cipher'));
  $('visitTaskBtn').addEventListener('click', () => startTask('visit'));
  $('stayTaskBtn').addEventListener('click', () => startTask('stay'));
  $('photoTaskBtn').addEventListener('click', () => startTask('photo'));
  $('closeCallTaskBtn').addEventListener('click', () => startTask('closecall'));
  $('scanTaskBtn').addEventListener('click', () => startTask('scan'));
  $('proximityTaskBtn').addEventListener('click', () => startTask('proximity'));
  $('newRoundBtn').addEventListener('click', restartSamePlayersRound);
  $('postRoundSettingsBtn').addEventListener('click', returnToLobbyForSettings);
  $('leaveEndBtn').addEventListener('click', confirmLeaveRoom);
  $('modalCloseBtn').addEventListener('click', closeModal);
  $('modalRoot').addEventListener('click', (event) => { if (event.target.hasAttribute('data-close-modal')) closeModal(); });
  $('mapRadius').addEventListener('input', (event) => {
    const radius = Number(event.target.value);
    $('mapRadiusNumber').value=String(radius);
    $('mapRadiusValue').textContent = `${radius} m`;
    updateLobbyMap({ ...state.room, settings:{...state.room.settings, radius} }, isHost(), saveCenter);
    clearTimeout(state.radiusSaveTimer);
    state.radiusSaveTimer=setTimeout(()=>saveSettings({radius}),300);
  });
  $('mapRadiusNumber').addEventListener('change',event=>{
    const radius=clamp(50+Math.round((Number(event.target.value)-50)/25)*25,50,2000);
    event.target.value=String(radius); $('mapRadius').value=String(radius); $('mapRadiusValue').textContent=`${radius} m`;
    clearTimeout(state.radiusSaveTimer);
    if(state.room) updateLobbyMap({...state.room,settings:{...state.room.settings,radius}},isHost(),saveCenter);
    saveSettings({radius});
  });
  const commitMinutes=(inputId,key,min,max)=>{
    const input=$(inputId),value=clamp(Math.round(Number(input.value)||min),min,max);
    input.value=String(value);
    $(key==='hideDuration'?'hideDurationValue':'gameDurationValue').textContent=formatTime(value*60);
    saveSettings({[key]:value*60}); Sound.click();
  };
  $('hideDurationMinutes').addEventListener('change',()=>commitMinutes('hideDurationMinutes','hideDuration',1,5));
  $('gameDurationMinutes').addEventListener('change',()=>commitMinutes('gameDurationMinutes','gameDuration',5,30));
  document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => {
    const key = button.dataset.step;
    const delta = Number(button.dataset.delta);
    const current = Number(state.room?.settings?.[key] ?? DEFAULT_SETTINGS[key]);
    const min = key === 'hideDuration' ? 60 : 300;
    const max = key === 'hideDuration' ? 300 : 1800;
    const value=clamp(current + delta, min, max);
    saveSettings({ [key]:value });
    $(key==='hideDuration'?'hideDurationMinutes':'gameDurationMinutes').value=String(Math.round(value/60));
    $(key==='hideDuration'?'hideDurationValue':'gameDurationValue').textContent=formatTime(value);
    Sound.click();
  }));
  document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', () => saveSettings({ mode:input.value })));
  document.querySelectorAll('[data-skill]').forEach((input) => input.addEventListener('change', () => saveSettings({ skills:{ [input.dataset.skill]:input.checked } })));
  $('announcementsToggle').addEventListener('change', (event) => saveSettings({ announcements:event.target.checked }));
  $('seekerCount').addEventListener('change', (event) => {
    const max=Math.max(1,Math.min(10,activePlayers().length-1));
    const count=clamp(Math.round(Number(event.target.value)||1),1,max);
    event.target.value=String(count); event.target.max=String(max);
    $('hiderCountValue').textContent=String(Math.max(0,activePlayers().length-count));
    saveSettings({ seekerCount:count });
  });
  const gameTabs=[...document.querySelectorAll('.game-tab')];
  gameTabs.forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
  document.querySelectorAll('.tab-content').forEach((panel) => {
    let touchStart=null;
    panel.addEventListener('touchstart',(event)=>{
      const touch=event.touches?.[0];
      touchStart=event.touches?.length===1&&!event.target.closest('button,a,input,select,textarea')&&touch?{x:touch.clientX,y:touch.clientY}:null;
    },{passive:true});
    panel.addEventListener('touchend',(event)=>{
      if(!touchStart) return;
      const touch=event.changedTouches?.[0],dx=touch?touch.clientX-touchStart.x:0,dy=touch?touch.clientY-touchStart.y:0;
      touchStart=null;
      if(Math.abs(dx)<75||Math.abs(dx)<Math.abs(dy)*1.3) return;
      const current=gameTabs.findIndex((button)=>button.dataset.tab===document.querySelector('.tab-content.active')?.id);
      const next=Math.max(0,Math.min(gameTabs.length-1,current+(dx<0?1:-1)));
      if(next!==current) selectTab(gameTabs[next].dataset.tab);
    },{passive:true});
  });
  window.addEventListener('unhandledrejection', (event) => { event.preventDefault(); toast('Aktion nicht bestätigt', event.reason?.message || 'Bitte Verbindung prüfen und erneut versuchen.', 'danger'); });
  window.addEventListener('online', async () => { try { await initBackend(); bindConnection(); if (!state.roomCode) await restoreSession(); } catch (error) { toast('Verbindung fehlgeschlagen',error.message,'warn'); } });
  window.addEventListener('offline', () => { state.connected=false; state.zone=null; if(state.ownLocation) state.gpsSyncStatus='offline'; setConnectionBadge(); if(state.room&&state.room.phase!=='lobby') updateMap(state.room,state.uid,state.ownLocation||getSelf()?.location,currentRole(),state.gpsSyncStatus); });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') { cancelMapPlacement(); if(state.modalCloseable && !$('modalRoot').classList.contains('hidden')) closeModal(); } });
  bindConnection();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    let reloadForWorkerUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadForWorkerUpdate) return;
      reloadForWorkerUpdate = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('./sw.js', { updateViaCache:'none' })
      .then((registration) => registration.update().catch(() => {}))
      .catch((error) => console.warn('Service worker registration failed', error));
  }
  await restoreSession();
  state.tickHandle = window.setInterval(tick, 1000);
}

function bindConnection() {
  state.unsubscribeConnection?.();
  state.unsubscribeConnection = subscribeConnection((connected) => {
    state.connected = connected;
    if (!connected) { state.zone = null; if(state.ownLocation) state.gpsSyncStatus='offline'; }
    else if(state.ownLocation&&state.gpsSyncStatus==='offline') state.gpsSyncStatus='syncing';
    setConnectionBadge();
    if(state.room&&state.room.phase!=='lobby') updateMap(state.room,state.uid,state.ownLocation||getSelf()?.location,currentRole(),state.gpsSyncStatus);
  });
}

const SESSION_KEY = 'hideseek-session-v2';
function persistSession() {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ uid:state.uid, code:state.roomCode, name:state.playerName })); }
  catch { toast('Sitzung nicht gespeichert', 'Browserspeicher ist gesperrt. Nach Neuladen erneut beitreten.', 'warn'); }
}
async function restoreSession() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return; }
  if (!saved || !/^\d{4}$/.test(saved.code)) return;
  if (!['firebase','worker'].includes(getBackendMode())) return; // Keep the record for the next successful reconnect.
  if (saved.uid !== getPlayerUid()) {
    toast('Sitzung nicht wiederherstellbar', 'Die gespeicherte Firebase-Identität ist nicht mehr verfügbar. Bitte erneut beitreten.', 'warn');
    return;
  }
  try {
    const room = await getRoom(saved.code);
    if (!room || room.phase === 'closed' || !room.players?.[saved.uid] || room.players[saved.uid].status === 'left') {
      localStorage.removeItem(SESSION_KEY);
      toast('Sitzung beendet', 'Der Raum oder deine Teilnahme ist nicht mehr verfügbar.', 'warn');
      return;
    }
    state.uid = saved.uid; state.playerName = saved.name; state.roomCode = saved.code;
    state.room = room; state.subscriptionStartedAt = now();
    attachRoomListener(); showGameState(); renderAll();
    toast('Sitzung wiederhergestellt', `Raum ${saved.code}`, 'success');
  } catch (error) { toast('Wiederherstellung wartet', error.message, 'warn'); }
}

function validatePlayerName() {
  const name = ($('playerName').value.trim() || state.profile?.displayName || '').replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 18) { toast('Codename prüfen', 'Bitte nutze 2 bis 18 Zeichen.', 'warn'); return null; }
  if (!/^[\p{L}\p{N}_ -]+$/u.test(name)) { toast('Codename ungültig', 'Erlaubt sind Buchstaben, Ziffern, Leerzeichen, Unterstriche und Bindestriche.', 'warn'); return null; }
  return name;
}

async function createLobby() {
  const name = validatePlayerName();
  if (!name) return;
  $('createRoomBtn').disabled = true;
  try {
    await initBackend();
    bindConnection();
    const uid = getPlayerUid();
    let code = null;
    for (let i=0; i<18; i++) {
      const attempt = randomCode();
      const data = createRoomData(uid, name);
      data.code = attempt;
      const created = await createRoom(attempt, data);
      if (created) { code = attempt; break; }
    }
    if (!code) throw new Error('Es konnte kein freier Raumcode erstellt werden. Bitte erneut versuchen.');
    state.playerName = name;
    state.uid = uid;
    state.roomCode = code;
    state.subscriptionStartedAt = now();
    persistSession();
    attachRoomListener();
    showGameState();
    toast('Lobby erstellt', `Dein Raumcode ist ${code}. Teile ihn mit deinem Team.`, 'success');
    Sound.success();
  } catch (error) {
    console.error(error);
    toast('Lobby konnte nicht erstellt werden', error?.message || 'Bitte überprüfe die Verbindung.', 'danger');
  } finally { $('createRoomBtn').disabled = false; }
}

async function joinLobby() {
  const name = validatePlayerName();
  if (!name) return;
  const code = $('roomCode').value.trim();
  if (!/^\d{4}$/.test(code)) { toast('Raumcode prüfen', 'Bitte gib den vierstelligen Code ein.', 'warn'); return; }
  $('joinRoomBtn').disabled = true;
  try {
    await initBackend();
    bindConnection();
    const room = getBackendMode() === 'worker' ? null : await getRoom(code);
    if (getBackendMode() !== 'worker' && (!room || room.phase === 'closed')) { toast('Raum nicht gefunden', 'Überprüfe den Code oder bitte den Host um eine neue Lobby.', 'danger'); return; }
    let failure = null;
    const updated = getBackendMode() === 'worker' ? await workerCommand(code,'join',{name}) : await mutateRoom(code, (current) => {
      const result = addPlayerToRoom(current, getPlayerUid(), name);
      if (!result.ok) { failure = result.reason; return null; }
      return current;
    });
    if (!updated) { toast('Beitritt nicht möglich', failure || 'Lobby wurde geschlossen oder konnte nicht aktualisiert werden.', 'danger'); return; }
    state.playerName = name;
    state.uid = getPlayerUid();
    state.roomCode = code;
    state.subscriptionStartedAt = now();
    persistSession();
    attachRoomListener();
    if (getBackendMode() !== 'worker') showGameState();
    toast('Verbunden', `Du bist dem Raum ${code} beigetreten.`, 'success');
    Sound.success();
  } catch (error) {
    console.error(error);
    toast('Verbindung fehlgeschlagen', error?.message || 'Bitte erneut versuchen.', 'danger');
  } finally { $('joinRoomBtn').disabled = false; }
}

function attachRoomListener() {
  state.unsubscribe?.();
  const subscribedCode=state.roomCode;
  state.unsubscribe = subscribeRoom(subscribedCode, (room) => {
    if (state.roomCode !== subscribedCode) return;
    if (!room || room.phase === 'closed') {
      if (room && getBackendMode() === 'worker' && state.roomCode) leaveRoom(state.roomCode,state.uid).catch(()=>{});
      if (state.roomCode) toast('Raum geschlossen', 'Die Lobby ist nicht mehr verfügbar.', 'warn');
      localExit();
      return;
    }
    if (!room.players?.[state.uid] || room.players[state.uid].status === 'left') { localExit(); return; }
    const priorPhase = state.room?.phase;
    const priorRole = state.room?.players?.[state.uid]?.role;
    state.room = room;
    if (!state.ownLocation && room.players?.[state.uid]?.location) state.gpsSyncStatus='synced';
    const self = getSelf();
    // Persisted coordinates are not a fresh device measurement.
    showGameState();
    renderAll();
    handleAnnouncement(room);
    handleEffects(room);
    if (priorPhase !== room.phase) onPhaseChanged(room.phase);
    if(priorRole==='hider' && self.role==='spectator' && room.announcement?.targetId!==state.uid) showMoment('Du wurdest gefunden','Deine Runde ist vorbei. Die Rundenwertung bleibt sichtbar.','caught','⊗',3200);
    else if(priorRole==='hider' && self.role==='seeker' && room.announcement?.targetId!==state.uid) showMoment('Du wurdest infiziert','Jetzt hilfst du dem Suchteam bei der Jagd.','catch','ϟ',3000);
  }, (error) => {
    console.error('Room listener error', error);
    state.connected = false;
    setConnectionBadge();
    if (now()-(state.lastConnectionError || 0)>15000) { state.lastConnectionError=now(); toast('Verbindung unterbrochen', 'Die App versucht, die Verbindung wiederherzustellen.', 'warn', 5000); }
  });
}

function showGameState() {
  const inRoom = Boolean(state.roomCode);
  $('entryScreen').classList.toggle('hidden', inRoom);
  $('leaveBtn').classList.toggle('hidden', !inRoom);
  if (!inRoom) {
    $('lobbyScreen').classList.add('hidden');
    $('gameScreen').classList.add('hidden');
    return;
  }
  const phase = state.room?.phase || 'lobby';
  $('lobbyScreen').classList.toggle('hidden', phase !== 'lobby');
  $('gameScreen').classList.toggle('hidden', phase === 'lobby');
  if (phase !== 'lobby') {
    if (!window.__hideseekMapInitialized) {
      initMap();
      window.__hideseekMapInitialized = true;
      window.setTimeout(invalidateMapSize, 150);
    } else invalidateMapSize();
  }
}

function onPhaseChanged(phase) {
  state.revealDismissedPhase = null;
  state.lastCountdownSecond = null;
  if (phase === 'hide') {
    if (currentRole() === 'seeker') Sound.startTension();
    else Sound.go();
  } else Sound.stopTension();
  if (phase === 'playing') { Sound.go(); haptic([30,50,30]); showMoment('Die Jagd beginnt','Das Spielfeld ist freigegeben. Bleib aufmerksam.','start','⚡',2800); }
  if (phase === 'finished' && state.lastEndSoundPhase !== 'finished') { state.lastEndSoundPhase='finished'; Sound.alert(); haptic([70,80,70]); const won=state.room?.winner==='hiders'&&currentRole()==='hider'||state.room?.winner==='seekers'&&currentRole()==='seeker'; showMoment(won?'Sieg!':'Runde beendet',state.room?.winner==='hiders'?'Die Hider haben bis zum Ende durchgehalten.':'Das Suchteam hat die Hider gefunden.','win','✦',3200); }
  if (phase === 'lobby') state.lastEndSoundPhase=null;
  if (phase==='lobby' || phase==='finished') releaseRoundPhotos();
}

async function saveSettings(patch) {
  if (!state.roomCode || !isHost()) return;
  try {
    const result = getBackendMode() === 'worker' ? await workerCommand(state.roomCode,'settings',{patch}) : await mutateRoom(state.roomCode, (room) => updateSettings(room, state.uid, patch));
    if (!result) throw new Error('Einstellung wurde abgewiesen. Bitte Raumstatus prüfen.');
  } catch (error) { toast('Einstellung nicht gespeichert', error?.message || 'Bitte erneut versuchen.', 'danger'); }
}

function renderAll() {
  if (!state.room) return;
  if (state.room.phase === 'lobby') renderLobby();
  else renderGame();
  setConnectionBadge();
}

function saveCenter(center) { saveSettings({ center }); }

function renderLobby() {
  const room = state.room;
  $('lobbyRoomCode').textContent = room.code || state.roomCode;
  $('hostBadge').classList.toggle('hidden', !isHost());
  $('hostSettings').classList.toggle('hidden', !isHost());
  $('guestSettingsNote').classList.toggle('hidden', isHost());
  document.querySelectorAll('#hostSettings input, #hostSettings button').forEach((input) => { input.disabled = !isHost(); });
  updateLobbyMap(room, isHost(), saveCenter);
  const settings = room.settings || DEFAULT_SETTINGS;
  const active = activePlayers();
  $('lobbyPlayerCount').textContent = `${active.length} / ${MAX_PLAYERS}`;
  $('teamProgressBar').style.width = `${Math.min(100, active.length / MAX_PLAYERS * 100)}%`;
  $('hideDurationValue').textContent = formatTime(settings.hideDuration);
  $('gameDurationValue').textContent = formatTime(settings.gameDuration);
  if (document.activeElement !== $('mapRadius')) $('mapRadius').value = settings.radius;
  if (document.activeElement !== $('mapRadiusNumber')) $('mapRadiusNumber').value = settings.radius;
  $('mapRadiusValue').textContent = `${settings.radius} m`;
  if (document.activeElement !== $('hideDurationMinutes')) $('hideDurationMinutes').value = String(Math.max(1,Math.round(settings.hideDuration/60)));
  if (document.activeElement !== $('gameDurationMinutes')) $('gameDurationMinutes').value = String(Math.max(5,Math.round(settings.gameDuration/60)));
  $('announcementsToggle').checked = settings.announcements !== false;
  const seekerCount = Number(settings.seekerCount) || 1;
  if (document.activeElement !== $('seekerCount')) $('seekerCount').value = String(seekerCount);
  const maxSeekers=Math.max(1,Math.min(10,active.length-1));
  $('seekerCount').max=String(maxSeekers);
  $('hiderCountValue').textContent = String(Math.max(0, active.length - seekerCount));
  if (seekerCount >= active.length) $('hiderCountValue').textContent = 'mind. 1';
  document.querySelectorAll('input[name="mode"]').forEach((input) => { input.checked = input.value === settings.mode; });
  document.querySelectorAll('[data-skill]').forEach((input) => { input.checked = settings.skills?.[input.dataset.skill] !== false; });
  $('lobbyPlayers').innerHTML = active.map((player) => `
    <div class="lobby-player"><div class="player-avatar${avatarCosmetic(player)}">${escapeHTML((player.name || '?').slice(0,1).toUpperCase())}</div><div class="player-meta"><strong>${displayName(player)}${player.id === state.uid ? ' <span style="color:var(--cyan)">(DU)</span>' : ''}</strong><small>${player.isHost ? 'LOBBY HOST' : 'OPERATIVE'} · TEILNEHMER</small></div>${player.isHost ? '<span class="player-tag">★ HOST</span>' : '<span class="player-tag">READY</span>'}</div>
  `).join('');
  $('startGameBtn').classList.toggle('hidden', !isHost());
  const invalidRoles = Number(settings.seekerCount || 1) >= active.length;
  $('startGameBtn').disabled = active.length < MIN_PLAYERS || invalidRoles;
  $('startHint').textContent = active.length < MIN_PLAYERS ? `Mindestens ${MIN_PLAYERS} Spieler erforderlich.` : invalidRoles ? 'Mindestens ein Hider muss übrig bleiben. Reduziere die Seeker-Anzahl.' : `${active.length} Operatives bereit · ${settings.seekerCount || 1} Seeker · ${active.length - Number(settings.seekerCount || 1)} Hider. Rollen und Startfähigkeiten werden zufällig verteilt.`;
}

async function startGame() {
  const active = activePlayers();
  if (active.length < MIN_PLAYERS) { toast('Zu wenig Spieler', `Mindestens ${MIN_PLAYERS} Spieler werden benötigt.`, 'warn'); return; }
  if (Number(state.room?.settings?.seekerCount || 1) >= active.length) { toast('Rollenverteilung prüfen', 'Es muss mindestens ein Hider übrig bleiben.', 'warn'); return; }
  $('startGameBtn').disabled = true;
  try {
    let response;
    let hostLocation = state.ownLocation || getSelf()?.location;
    if (!validPoint(state.room?.settings?.center)) {
      hostLocation = await getFreshHostLocation();
      if (getBackendMode() === 'worker') {
        state.gpsSyncStatus = 'syncing';
        await updatePlayerLocation(state.roomCode, state.uid, hostLocation);
        state.lastLocationWrite = now();
        state.gpsSyncStatus = 'synced';
      }
    }
    const result = getBackendMode() === 'worker' ? await workerCommand(state.roomCode,'start') : await mutateRoom(state.roomCode, (room) => {
      response = startCountdown(room, state.uid, hostLocation);
      if (!response.ok) return null;
      return room;
    });
    if (!result) { toast('Einsatz konnte nicht starten', response?.reason || 'Bitte Lobby und Verbindung prüfen.', 'danger'); return; }
    Sound.go();
  } catch (error) { toast('Start fehlgeschlagen', error?.message || 'Bitte erneut versuchen.', 'danger'); }
  finally { $('startGameBtn').disabled = false; }
}

function getFreshHostLocation() {
  const current = state.ownLocation;
  if (current && now() - current.measuredAt <= 10000 && current.accuracy <= 25) return Promise.resolve(current);
  if (!navigator.geolocation) return Promise.reject(new Error('Zum automatischen Festlegen der Spielfeldmitte wird GPS benötigt.'));
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition((position) => {
      try {
        const location = makeLocationSample(position, now());
        if (location.accuracy > 25) throw new Error('GPS ist noch zu ungenau. Bitte kurz warten und erneut starten.');
        state.ownLocation = location;
        state.gpsError = null;
        resolve(location);
      } catch (error) { reject(error); }
    }, (error) => {
      const message = error?.code === 1 ? 'Erlaube GPS im Browser, damit die Spielfeldmitte automatisch gesetzt werden kann.' : 'GPS ist gerade nicht verfügbar. Bitte erneut versuchen.';
      reject(new Error(message));
    }, { enableHighAccuracy:true, timeout:15000, maximumAge:2500 });
  });
}

function renderGame() {
  const room = state.room;
  const self = getSelf();
  if (!self) { toast('Spieler nicht gefunden', 'Tritt dem Raum erneut bei.', 'danger'); return; }
  const phase = room.phase;
  const role = self.role || 'waiting';
  $('gameRoomCode').textContent = state.roomCode;
  $('phaseLabel').textContent = PHASE_LABELS[phase] || 'LIVE MATCH';
  $('roundEndScreen').classList.toggle('hidden', phase !== 'finished');
  if (phase === 'finished') {
    const localWinner=room.winner || (room.settings.mode === 'infected' ? 'seekers' : 'hiders');
    $('winnerTitle').textContent=localWinner==='hiders' ? 'Hider gewinnen' : 'Seeker gewinnen';
    $('winnerMessage').textContent=localWinner==='hiders' ? 'Die Hider haben bis zum Ende durchgehalten.' : 'Das Suchteam hat die Runde beendet.';
    $('newRoundBtn').classList.toggle('hidden', !isHost());
    $('postRoundSettingsBtn').classList.toggle('hidden', !isHost());
    renderRoundResults(room);
  }
  renderRoundPhotoGallery(room,role);
  $('gameModeTag').textContent = room.settings.mode === 'infected' ? 'INFECTED MODE' : 'CLASSIC MODE';
  $('phaseDot').style.background = phase === 'finished' ? 'var(--muted)' : phase === 'playing' ? 'var(--red)' : 'var(--neon)';
  $('phaseDot').style.boxShadow = phase === 'playing' ? '0 0 8px var(--red)' : '0 0 8px var(--neon)';
  $('gameGreeting').textContent = role === 'seeker' ? 'Jage die Signale.' : role === 'spectator' ? 'Beobachte das Feld.' : role === 'hider' ? 'Bleib unsichtbar.' : 'Mission bereit.';
  $('gameSubheading').textContent = phase === 'countdown' ? 'Synchronisiere dich mit deinem Team.' : phase === 'reveal' ? 'Deine Identität wird bestätigt.' : phase === 'hide' ? (role === 'seeker' ? 'Hold position. Die Hider haben Vorsprung.' : 'Finde einen sicheren, öffentlichen Ort zum Verstecken.') : phase === 'playing' ? 'Der Einsatz läuft. Nutze Skills und Signal Caches.' : 'Diese Runde ist beendet.';
  $('operativeName').textContent = self.name;
  $('operativeAvatar').textContent = (self.name || '?').slice(0,1).toUpperCase();
  $('operativeAvatar').className=`operative-avatar${avatarCosmetic(self||state.profile)}`;
  $('operativeRole').textContent = role === 'seeker' ? (room.settings.mode === 'infected' && self.status === 'infected' ? 'INFIZIERT / SEEKER' : 'SEEKER') : role === 'hider' ? 'HIDER' : role === 'spectator' ? 'ZUSCHAUER' : 'BEREIT';
  $('operativeRole').className = `role-chip ${role === 'seeker' ? 'role-seeker' : role === 'spectator' ? 'role-spectator' : 'role-hider'}`;
  $('roleChip').textContent = $('operativeRole').textContent;
  $('operativeCoins').textContent = String(self.coins || 0);
  $('operativeScore').textContent = String(self.score || 0);
  $('coinBadge').textContent = `${self.coins || 0} ◈`;
  $('shopCoinCounter').textContent = `${self.coins || 0} ◈`;
  $('operativeItems').textContent = String((self.inventory || []).length);
  const cooldownLeft=Math.max(0,Math.ceil(((Number(self.taskCooldownUntil)||0)-now())/1000));
  const tasksUnavailable=getBackendMode()!=='worker';
  $('taskBackendNotice').classList.toggle('hidden',!tasksUnavailable);
  if(tasksUnavailable) $('taskBackendNotice').textContent='Servergeprüfte Aufgaben sind gesperrt, bis Cloudflare Worker/D1 eingerichtet und WORKER_URL gesetzt ist.';
  $('taskCooldown').textContent=cooldownLeft ? `Aufgaben-Cooldown: ${cooldownLeft} s` : '';
  $('taskCooldown').classList.toggle('hidden',!cooldownLeft);
  for (const id of ['startTaskBtn','visitTaskBtn','stayTaskBtn','photoTaskBtn','closeCallTaskBtn']) if ($(id)) $(id).disabled=tasksUnavailable || cooldownLeft>0 || !canUseGame() || role!=='hider';
  const inventory = self.inventory || [];
  const activeSkill = inventory[0] ? SKILLS[inventory[0]] : null;
  $('activeSkillName').textContent = activeSkill?.short || (self.effects?.shield ? 'Schild aktiv' : 'Kein Skill bereit');
  $('activeSkillIcon').textContent = activeSkill ? (SKILL_ICONS[activeSkill.id] || activeSkill.icon) : '◇';
  $('activateSkillBtn').disabled = !canUseGame() || (self.effects?.frozenUntil||0)>now() || (!inventory.length && !self.effects?.shield);
  $('activateSkillBtn').textContent = inventory.length ? 'Fähigkeit einsetzen ↗' : 'Keine Fähigkeit bereit';
  $('activateSkillBtn').innerHTML = `${inventory.length ? 'Fähigkeit einsetzen' : 'Keine Fähigkeit bereit'} <span>↗</span>`;
  $('matchTimer').textContent = timerText();
  $('timerCaption').textContent = phase === 'hide' ? (role === 'seeker' ? 'LOCKDOWN TIMER' : 'HIDE TIMER') : ['countdown','reveal'].includes(phase) ? 'START IN' : 'MATCH TIMER';
  const totalTime = phase === 'hide' ? Number(room.settings.hideDuration) : phase === 'playing' ? Number(room.settings.gameDuration) : phase === 'countdown' ? 10 : phase === 'reveal' ? 5 : 0;
  const timeLeft = timerSeconds();
  $('timerProgress').style.width = `${totalTime > 0 ? clamp(timeLeft / totalTime * 100, 0,100) : 0}%`;
  $('freezeTimer').textContent = formatTime(timerSeconds());
  const seekerLock = phase === 'hide' && role === 'seeker';
  const empFrozen = (self.effects?.frozenUntil || 0) > now() && phase === 'playing';
  $('hideFreeze').classList.toggle('hidden', !seekerLock && !empFrozen);
  if (empFrozen) {
    const hiderFreeze=self.effects?.freezeSource==='hider';
    $('hideFreeze').querySelector('h2').innerHTML = hiderFreeze ? 'FROST <br><span class="text-neon">LOCKDOWN.</span>' : 'EMP <br><span class="text-neon">LOCKDOWN.</span>';
    $('hideFreeze').querySelector('p').textContent = hiderFreeze ? 'Ein Hider hat dich kurz eingefroren. Die Spielaktionen werden gleich wieder freigegeben.' : 'Eine digitale Falle hat dein Signal blockiert. Bewege dich nicht in Gefahr und warte auf die Freigabe.';
    $('hideFreeze').querySelector('.freeze-icon').textContent = hiderFreeze ? '❄' : '⌁';
    $('freezeTimer').textContent = formatTime(Math.ceil((self.effects.frozenUntil - now()) / 1000));
    $('hideFreeze').querySelector('.freeze-sub').textContent = 'SIGNAL RESTORE IN PROGRESS';
  } else {
    $('hideFreeze').querySelector('h2').innerHTML = 'Bleib auf<br><span class="text-neon">Position.</span>';
    $('hideFreeze').querySelector('p').textContent = 'Die Hider bekommen einen Vorsprung. Deine Karte bleibt gesperrt, bis die Zeit abgelaufen ist.';
    $('hideFreeze').querySelector('.freeze-icon').textContent = '⌁';
    $('hideFreeze').querySelector('.freeze-sub').textContent = 'SUCHPHASE WIRD VORBEREITET';
  }
  const shouldReveal = phase === 'reveal' && state.revealDismissedPhase !== phase;
  $('roleReveal').classList.toggle('hidden', !shouldReveal);
  $('roleRevealSymbol').textContent = role === 'seeker' ? '⊕' : '✧';
  $('roleRevealTitle').textContent = role === 'seeker' ? 'DU BIST SEEKER' : 'DU BIST HIDER';
  $('roleRevealCopy').textContent = role === 'seeker' ? 'Dein Signal wird gleich freigeschaltet. Nutze den Vorsprung der anderen, um deine Strategie zu planen.' : 'Behalte deine Position im Blick, sammle Skills und weiche dem Suchteam aus.';
  $('catchPanel').classList.toggle('hidden', !(phase === 'playing' && role === 'seeker' && self.active));
  $('spectatorBanner').classList.toggle('hidden', role !== 'spectator');
  $('gpsBtn').textContent = state.ownLocation ? '◎ GPS verbunden' : '◎ GPS aktivieren';
  $('mapNotice').classList.toggle('hidden', Boolean(state.ownLocation));
  $('mapNotice').querySelector('strong').textContent = state.ownLocation ? 'GPS verbunden' : 'GPS noch nicht aktiv';
  $('mapNotice').querySelector('small').textContent = state.ownLocation ? 'Dein Standort wird serverseitig synchronisiert und nur für nötige Spielaktionen freigegeben.' : 'Standort freigeben, um deine Position auf der Karte anzuzeigen.';
  const mapLocked = seekerLock || empFrozen || phase === 'countdown' || phase === 'reveal';
  const jammed = role === 'hider' && (room.effects?.jammerUntil || 0) > now();
  $('map').style.filter = jammed ? 'grayscale(.8) contrast(1.25) brightness(.72)' : '';
  $('map').style.opacity = mapLocked ? '.13' : '1';
  if (jammed && phase === 'playing') {
    $('mapCaption').textContent = `RADAR-JAMMER AKTIV · ${Math.ceil((room.effects.jammerUntil-now())/1000)} S`;
  }
  $('map').style.pointerEvents = mapLocked ? 'none' : '';
  if (mapLocked) $('mapNotice').classList.add('hidden');
  renderSpecialNotices(self);
  renderRoster();
  renderQuickActions();
  renderShop();
  renderNearbyItems();
  renderLeaderboard();
  if (room.phase !== 'lobby') updateMap(room, state.uid, state.ownLocation || self.location, role,state.gpsSyncStatus);
  if(['hide','playing'].includes(phase)&&state.gpsAuthorized) startGPSWatch();
  else if(state.watchId!==null&&phase!=='hide'&&phase!=='playing') { navigator.geolocation.clearWatch(state.watchId); state.watchId=null; }
}

function timerSeconds() {
  const room = state.room;
  if (!room) return 0;
  if (room.phase === 'playing') return Math.max(0, Math.ceil(((room.matchEndsAt || room.phaseEndsAt || 0) - now()) / 1000));
  if (['countdown','reveal','hide'].includes(room.phase)) return Math.max(0, Math.ceil(((room.phaseEndsAt || 0) - now()) / 1000));
  return 0;
}
function timerText() { return formatTime(timerSeconds()); }

function renderRoster() {
  const players = Object.values(state.room.players || {}).sort((a,b) => {
    const order = {seeker:0,hider:1,spectator:2,waiting:3};
    return (order[a.role] ?? 5) - (order[b.role] ?? 5) || a.joinedAt - b.joinedAt;
  });
  $('gamePlayerCount').textContent = String(players.filter((p) => p.active).length);
  $('sideRoster').innerHTML = players.map((player) => {
    const roleText = player.role === 'seeker' ? (player.status === 'infected' ? 'INFIZIERT' : 'SEEKER') : player.role === 'hider' ? 'HIDER' : player.role === 'spectator' ? 'GEFANGEN' : player.active ? 'LOBBY' : 'ABGEMELDET';
    const statusClass = player.role === 'hider' ? 'alive' : player.role === 'seeker' ? 'infected' : '';
    return `<div class="roster-player"><div class="player-avatar${avatarCosmetic(player)}">${escapeHTML((player.name||'?').slice(0,1).toUpperCase())}</div><div class="player-meta"><strong>${displayName(player)}${player.id === state.uid ? ' · DU' : ''}</strong><small>${player.isHost ? 'HOST · ' : ''}${player.status === 'left' ? 'OFFLINE' : player.active ? 'ONLINE' : 'INAKTIV'}</small></div><span class="roster-state ${statusClass}">${roleText}</span></div>`;
  }).join('');
}

function renderQuickActions() {
  const self = getSelf();
  const role = self?.role;
  const phase = state.room.phase;
  const canAct = canUseGame() && !(role === 'seeker' && phase === 'hide') && (self?.effects?.frozenUntil||0)<=now();
  const inventory = self?.inventory || [];
  const actions = [];
  if (role === 'seeker') {
    actions.push({icon:'◉',title:'Sonar Ping',detail:`Hider ${skillTuning('sonar',state.room.settings).duration} Sek. orten`,action:()=>useSkillFromInventory('sonar'),disabled:!canAct || !inventory.includes('sonar')});
    actions.push({icon:'⌖',title:'GPS-Tracker',detail:'Nächsten Hider verfolgen',action:()=>useSkillFromInventory('tracker'),disabled:!canAct || !inventory.includes('tracker')});
    actions.push({icon:'➤',title:'Kompass',detail:'Entferntesten Hider peilen',action:()=>useSkillFromInventory('compass'),disabled:!canAct || !inventory.includes('compass')});
    const tuning=tacticalTuning(state.room.settings);
    const workerReady=getBackendMode()==='worker';
    actions.push({icon:'⊘',title:'Sperrzone',detail:`Einstellbar · ab ${tuning.zoneCostFor(tuning.minZoneRadius)} P · Ø ${tuning.zoneRadius*2} m`,action:startRestrictedZonePlacement,disabled:!canAct||!workerReady||Number(self.score||0)<tuning.zoneCostFor(tuning.minZoneRadius)||(self.tacticalCooldowns?.zone||0)>now()});
    actions.push({icon:'⇄',title:'Zeit tauschen',detail:`30–90 Sek. gegen Punkte · ${Number(self.timeExchangesUsed||0)}/3`,action:openTimeTrade,disabled:!canAct||!workerReady||Number(self.timeExchangesUsed||0)>=3});
    const hiders=Object.values(state.room.players||{}).filter(candidate=>candidate.active&&candidate.role==='hider');
    actions.push({icon:'↗',title:'Hider umpositionieren',detail:`Abstand ${tuning.relocateDistance} m · ab ${tuning.relocationCost('random')} P`,action:openRelocationOptions,disabled:!canAct||!workerReady||!hiders.length||Number(self.score||0)<tuning.relocationCost('random')||(self.tacticalCooldowns?.relocate||0)>now()});
  } else if (role === 'hider') {
    actions.push({icon:'✧',title:'Geist-Modus',detail:`GPS ${skillTuning('ghost',state.room.settings).duration} Sek. verbergen`,action:()=>useSkillFromInventory('ghost'),disabled:!canAct || !inventory.includes('ghost')});
    actions.push({icon:'◈',title:'Täusch-Ping',detail:'Falschen Marker setzen',action:()=>startDecoyPlacement(),disabled:!canAct || !inventory.includes('decoy')});
    actions.push({icon:'⌗',title:'EMP-Falle',detail:'Falle am Standort legen',action:()=>useSkillFromInventory('trap'),disabled:!canAct || !inventory.includes('trap') || !state.ownLocation});
    if(inventory.includes('freeze')) { const tuning=skillTuning('freeze',state.room.settings); actions.push({icon:'❄',title:'Frostimpuls',detail:`Seeker einfrieren · ${tuning.freezeRadius} m · ${tuning.duration} s`,action:()=>useSkillFromInventory('freeze'),disabled:!canAct}); }
  }
  actions.push({icon:'▤',title:'Aufgaben auswählen',detail:'Hider-Challenges öffnen',action:()=>selectTab('tasksTab'),disabled:!canAct || role!=='hider'});
  $('quickActions').innerHTML = actions.map((item,index) => `<button class="quick-action" type="button" data-quick="${index}" ${item.disabled ? 'disabled' : ''}><span>${item.icon}</span><strong>${item.title}</strong><small>${item.detail}</small></button>`).join('');
  $('quickActions').querySelectorAll('[data-quick]').forEach((button,index) => button.addEventListener('click', actions[Number(button.dataset.quick)].action));
}

async function runTacticalAbility(ability,payload,successTitle,successMessage) {
  if(getBackendMode()!=='worker') { toast('Sichere Fähigkeiten nicht verfügbar','Für Punkte-Fähigkeiten ist das serverseitige Worker-Backend erforderlich.','warn'); return; }
  try {
    const response=await workerCommand(state.roomCode,'useTacticalAbility',{ability,...payload});
    if(!response.result) { toast('Fähigkeit nicht aktiviert','Prüfe Punkte, GPS und Spielphase.','warn'); return; }
    Sound.success(); haptic([20,30,20]); toast(successTitle,successMessage,'success');
  } catch(error) { toast('Fähigkeit nicht aktiviert',error.message||'Bitte Verbindung und Punkte prüfen.','warn',5500); }
}

function placeRestrictedZone(radius,settings=state.room?.settings||{}) {
  const tuning=tacticalTuning(settings),cost=tuning.zoneCostFor(radius),self=getSelf();
  if(!self||Number(self.score||0)<cost) { toast('Zu wenig Punkte',`Diese Sperrzone kostet ${cost} Punkte.`,'warn'); return; }
  selectTab('mapTab');
  if(!beginMapPlacement(async center=>{
    const zoneCenter=settings.center,mapRadius=Number(settings.radius)||500;
    if(!zoneCenter||distanceMeters(center,zoneCenter)>mapRadius-radius) {
      toast('Kreis passt nicht in die Spielzone','Verschiebe den Vorschaukreis vollständig in den Spielfeldrand.','warn');
      placeRestrictedZone(radius,settings); return;
    }
    await runTacticalAbility('zone',{center,radius},'Sperrzone aktiviert',`Radius ${radius} m · bis zum Rundenende. Wer bereits darin steht, hat 45 Sekunden zum Verlassen.`);
  },{radius,confirm:true,hint:'Tippe auf die Karte für die Vorschau des Sperrkreises'})) { toast('Karte nicht bereit','Öffne zuerst die Spielkarte.','warn'); return; }
  toast('Sperrzone platzieren',`Radius ${radius} m · bis zum Rundenende · ${cost} Punkte. Tippe auf die Karte, prüfe den Kreis und bestätige ihn.`,'info',5500);
}

function startRestrictedZonePlacement() {
  const self=getSelf(),settings=state.room?.settings||{},tuning=tacticalTuning(settings);
  if(!self) return;
  openModal({kicker:'SEEKER / ZONENKONTROLLE',title:'Sperrzone einstellen',body:`<p class="modal-copy">Der Bereich bleibt bis zum Rundenende gesperrt. Größe und Preis passen sich Spielfeld und Rundendauer an. Pro Seeker ist ein Kreis möglich, insgesamt höchstens drei. Platziere ihn vollständig innerhalb des Spielfelds.</p><label class="modal-field-label" for="restrictedRadius">Radius · ${tuning.minZoneRadius}–${tuning.maxZoneRadius} m</label><input id="restrictedRadius" class="modal-input" type="number" inputmode="numeric" min="${tuning.minZoneRadius}" max="${tuning.maxZoneRadius}" step="1" value="${tuning.zoneRadius}"><p class="modal-copy">Kosten: <strong id="restrictedCost">${tuning.zoneCostFor()}</strong> Punkte · Spieler im Kreis haben 45 Sekunden zum Verlassen.</p>`,actions:[{label:'Abbrechen',variant:'button-secondary'},{label:'Auf Karte platzieren',variant:'button-primary',keepOpen:true,onClick:()=>{
    const radius=Number($('restrictedRadius')?.value);
    if(!Number.isInteger(radius)||radius<tuning.minZoneRadius||radius>tuning.maxZoneRadius) { toast('Werte prüfen',`Radius: ${tuning.minZoneRadius}–${tuning.maxZoneRadius} m.`,'warn'); return; }
    closeModal();
    placeRestrictedZone(radius,settings);
  }}]});
  const updateCost=()=>{ const radius=Number($('restrictedRadius')?.value); if(Number.isInteger(radius)) $('restrictedCost').textContent=String(tuning.zoneCostFor(radius)); };
  $('restrictedRadius')?.addEventListener('input',updateCost);
}

function openTimeTrade() {
  const self=getSelf(),settings=state.room?.settings||{},tuning=tacticalTuning(settings),remaining=timerSeconds(),used=Number(self?.timeExchangesUsed)||0;
  if(used>=3) { toast('Tauschlimit erreicht','Du kannst pro Runde höchstens drei Zeit-Tausche nutzen.','warn'); return; }
  const options=[30,60,90].map(seconds=>{
    const reward=tuning.exchangeReward(seconds),available=remaining-seconds>=300;
    return `<button type="button" class="modal-option" data-time-trade="${seconds}" ${available?'':'disabled'}><span class="player-avatar">⇄</span><span><strong>${seconds} Sekunden gegen +${reward} Punkte</strong><small>${available?'Die Runde endet entsprechend früher.':'Mindestens fünf Minuten müssen übrig bleiben.'}</small></span></button>`;
  }).join('');
  openModal({kicker:'SEEKER / ZEIT GEGEN PUNKTE',title:'Zeit eintauschen',body:`<p class="modal-copy">Du verkürzt die Runde und erhältst dafür Punkte. Es bleiben immer mindestens fünf Minuten; pro Seeker sind drei Tausche möglich.</p><div class="modal-option-list">${options}</div>`,actions:[{label:'Schließen',variant:'button-secondary'}]});
  $('modalBody').querySelectorAll('[data-time-trade]').forEach(button=>button.addEventListener('click',()=>{
    const seconds=Number(button.dataset.timeTrade),reward=tuning.exchangeReward(seconds);
    closeModal();
    runTacticalAbility('exchangeTime',{seconds},'Zeit eingetauscht',`−${seconds} Sekunden · +${reward} Punkte.`);
  }));
}

function openRelocationOptions() {
  const self=getSelf(),settings=state.room?.settings||{},tuning=tacticalTuning(settings),hiders=Object.values(state.room?.players||{}).filter(player=>player.active&&player.role==='hider');
  if(!hiders.length) { toast('Keine aktiven Hider','Es gibt gerade niemanden zum Umpositionieren.','warn'); return; }
  const choices=hiders.map(player=>`<option value="${escapeHTML(player.id)}">${escapeHTML(player.name||'Hider')}</option>`).join('');
  openModal({kicker:'SEEKER / POSITION RESET',title:'Hider umpositionieren',body:`<p class="modal-copy">Betroffene Hider müssen sich mindestens ${tuning.relocateDistance} m von ihrem letzten GPS-Punkt entfernen. Die Koordinaten bleiben privat. Sichere, öffentliche Wege wählen.</p><label class="modal-field-label" for="relocationTarget">Hider für Einzelziel</label><select id="relocationTarget" class="modal-input">${choices}</select>`,actions:[
    {label:`Ein Hider · ${tuning.relocationCost('one')} P`,variant:'button-secondary',onClick:()=>runTacticalAbility('relocate',{mode:'one',targetId:$('relocationTarget')?.value},'Umpositionierung gestartet',`Ein Hider muss mindestens ${tuning.relocateDistance} m weiterziehen.`)},
    {label:`Zufällig · ${tuning.relocationCost('random')} P`,variant:'button-secondary',onClick:()=>runTacticalAbility('relocate',{mode:'random'},'Umpositionierung gestartet',`Ein zufälliger Hider muss mindestens ${tuning.relocateDistance} m weiterziehen.`)},
    {label:`Alle · ${tuning.relocationCost('all',hiders.length)} P`,variant:'button-primary',onClick:()=>runTacticalAbility('relocate',{mode:'all'},'Umpositionierung gestartet',`${hiders.length} Hider müssen mindestens ${tuning.relocateDistance} m weiterziehen.`)}
  ]});
}

function renderSpecialNotices(self) {
  const relocation=$('relocationNotice'),zoneNotice=$('zoneEvacuationNotice'),proximity=$('proximityNotice');
  const pending=state.room?.phase==='playing'&&self?.role==='hider'?self.forcedRelocation:null;
  relocation?.classList.toggle('hidden',!pending);
  if(relocation&&pending) {
    const own=state.ownLocation||self.location,covered=own?Math.min(pending.minimumMeters,distanceMeters(own,pending.from)):0;
    const pct=Math.round(covered/pending.minimumMeters*100);
    const deadline=pending.deadlineAt||pending.createdAt+tacticalTuning(state.room.settings).relocationDeadlineSeconds*1000,remaining=Math.max(0,Math.ceil((deadline-now())/1000));
    relocation.innerHTML=`<strong>JETZT UMSETZEN · NOCH ${formatTime(remaining)}</strong><span>Verlasse den markierten Kreis und erreiche mindestens ${pending.minimumMeters} m Abstand: ${Math.round(covered)} / ${pending.minimumMeters} m. Sonst scheidest du aus.</span><div class="relocation-progress"><i style="width:${pct}%"></i></div>`;
  }
  const obligations=state.room?.phase==='playing'&&self?.role==='hider'?Object.values(self.zoneEvacuations||{}).filter(item=>item?.deadlineAt):[];
  const evacuation=obligations.sort((a,b)=>a.deadlineAt-b.deadlineAt)[0];
  zoneNotice?.classList.toggle('hidden',!evacuation);
  if(zoneNotice&&evacuation) {
    const zone=state.room?.restrictedZones?.[evacuation.zoneId],remaining=Math.max(0,Math.ceil((evacuation.deadlineAt-now())/1000));
    const radius=Number(zone?.radius)||0;
    zoneNotice.innerHTML=`<strong>SPERRZONE VERLASSEN · NOCH ${formatTime(remaining)}</strong><span>Du stehst im markierten Sperrkreis${radius?` mit ${radius} m Radius`:''}. Geh jetzt auf einem sicheren Weg hinaus oder scheide aus.</span><div class="relocation-progress"><i style="width:${Math.max(0,Math.min(100,remaining/45*100))}%"></i></div>`;
  }
  const task=self?.activeTask;
  if(self?.active&&task&&['closecall','photo'].includes(task.kind)&&(task.completed||task.failed)) {
    const resultKey=`${state.room?.roundId}:${task.id}:${task.failed?'failed':'complete'}`;
    if(state.lastRiskResult!==resultKey) {
      state.lastRiskResult=resultKey;
      if(task.failed) toast('Aufgabe beendet',task.failureReason||'Der Versuch wurde beendet.','warn',6500);
      else if(task.kind==='closecall') toast('Mutprobe beendet',`+${Number(task.pointsAwarded)||0} Punkte. Dein einmaliger Versuch für diese Runde ist verbraucht.`,'success',5500);
    }
  }
  const challenge=self?.active&&self?.role==='hider'&&['hide','playing'].includes(state.room?.phase)&&task&&!task.completed&&!task.failed&&['closecall','photo'].includes(task.kind)?task:null;
  proximity?.classList.toggle('hidden',!challenge);
  if(proximity&&challenge) {
    if(challenge.kind==='closecall') {
      const left=Math.max(0,Math.ceil((challenge.expiresAt-now())/1000));
      proximity.innerHTML=`<strong>MUTPROBE · +${Number(challenge.pointsAwarded)||0} PUNKTE · NOCH ${left} S</strong><span>+1 Punkt pro bestätigter Sekunde innerhalb von 15 m. Nur ein Versuch pro Runde. Verlassen oder GPS-Lücken beenden die Aufgabe.</span>`;
    } else if(challenge.photoSubmittedAt) {
      const elapsed=Math.min(challenge.duration,Number(challenge.heldMs)||0),left=Math.ceil((challenge.duration-elapsed)/1000);
      proximity.innerHTML=`<strong>VERSTECKFOTO · NOCH ${formatTime(left)} HALTEN</strong><span>Bleibe innerhalb von 10 m. Bestätigtes Verlassen: −15 Punkte. GPS-Lücken starten die Haltezeit neu, ohne Punktabzug. Abschluss automatisch nach drei Minuten.</span><div class="relocation-progress"><i style="width:${Math.round(elapsed/challenge.duration*100)}%"></i></div>`;
    } else proximity.classList.add('hidden');
  }
}

function renderShop() {
  const self = getSelf();
  if (!self) return;
  const side = self.role === 'seeker' ? 'seeker' : self.role === 'hider' ? 'hider' : null;
  const available = SKILL_IDS.map((id) => SKILLS[id]).filter((skill) => skill.side === side && state.room.settings.skills?.[skill.id] !== false);
  if (!side) {
    $('shopGrid').innerHTML = '<div class="empty-state">Im Zuschauer-Modus steht das Arsenal nicht zur Verfügung.</div>';
  } else if (!available.length) {
    $('shopGrid').innerHTML = '<div class="empty-state">Der Host hat alle Fähigkeiten dieser Rolle deaktiviert.</div>';
  } else {
    $('shopGrid').innerHTML = available.map((skill) => {
      const tuned=skillTuning(skill.id,state.room.settings);
      const phaseAllowed = state.room.phase === 'playing' || (side === 'hider' && state.room.phase === 'hide');
      const disabled = !phaseAllowed || Number(self.coins || 0) < tuned.price;
      const effect=skill.id==='sweeper'?`Räumradius ${tuned.sweepRadius} m`:skill.id==='trap'?`EMP-Radius ${tuned.trapRadius} m · ${tuned.duration*6} s`:skill.id==='decoy'?`Marker bis ${tuned.decoyRange} m vom Zentrum · ${tuned.duration} s`:skill.id==='freeze'?`Reichweite ${tuned.freezeRadius} m · ${tuned.duration} s`:tuned.duration?`${tuned.duration} Sekunden Wirkung`:'Einmaliger Schutz';
      return `<article class="shop-item"><div class="shop-item-top"><span class="shop-item-icon">${SKILL_ICONS[skill.id] || skill.icon}</span><span class="shop-price">◈ ${tuned.price}</span></div><span class="shop-side-label">${side === 'seeker' ? 'SEEKER TECH' : 'HIDER TECH'} · ZONE ${state.room.settings.radius} M</span><h3>${escapeHTML(skill.short)}</h3><p>${escapeHTML(skill.description)} <strong>${effect}</strong></p><button class="button button-secondary" data-buy-skill="${skill.id}" type="button" ${disabled ? 'disabled' : ''}>${phaseAllowed ? 'Kaufen' : 'Später verfügbar'} <span>→</span></button></article>`;
    }).join('');
    $('shopGrid').querySelectorAll('[data-buy-skill]').forEach((button) => button.addEventListener('click', async () => {
      const result = await buySkill(state.roomCode, state.uid, button.dataset.buySkill);
      if (result.ok) { Sound.success(); haptic(25); toast('Skill gekauft', `${SKILLS[button.dataset.buySkill].short} wurde ins Arsenal gelegt.`, 'success'); }
      else toast('Kauf nicht möglich', result.reason, 'warn');
    }));
  }
  const inventory = self.inventory || [];
  $('inventoryPanel').innerHTML = `<div class="inventory-title"><strong>Dein Inventar</strong><span>${inventory.length} SKILL${inventory.length === 1 ? '' : 'S'}</span></div>${inventory.length ? `<div class="inventory-list">${inventory.map((id,index) => `<button class="inventory-chip" type="button" data-use-inventory="${index}"><b>${SKILL_ICONS[id] || '◇'}</b>${escapeHTML(SKILLS[id]?.short || id)}</button>`).join('')}</div>` : '<div class="empty-state">Noch keine ungenutzten Skills. Sammle Caches oder löse Aufgaben.</div>'}`;
  $('inventoryPanel').querySelectorAll('[data-use-inventory]').forEach((button) => button.addEventListener('click', () => useSkillFromInventory(null, Number(button.dataset.useInventory))));
}

function renderNearbyItems() {
  const self = getSelf();
  const loc = state.ownLocation || self?.location;
  const boxes = Object.values(state.room.itemBoxes || {}).filter((box) => !box.collected).map((box) => ({...box,distance:distanceMeters(loc,box.location)})).sort((a,b) => a.distance - b.distance).slice(0,4);
  if (!boxes.length) {
    $('nearbyItems').innerHTML = '<div class="empty-state">Keine aktiven Caches. Neue Signal Caches erscheinen im Einsatzgebiet.</div>';
    return;
  }
  $('nearbyItems').innerHTML = boxes.map((box) => {
    const distance = Number.isFinite(box.distance) ? Math.round(box.distance) : null;
    const close = distance !== null && distance <= 15;
    return `<div class="cache-row"><span class="cache-icon">▣</span><div class="cache-info"><strong>Signal Cache</strong><small>${distance === null ? 'GPS NÖTIG' : distance <= 15 ? 'IN REICHWEITE' : `${distance} M ENTFERNT`}</small></div><button type="button" data-collect-box="${box.id}" ${!close || state.room.phase !== 'playing' ? 'disabled' : ''}>${close ? 'Sammeln' : 'Lokalisieren'}</button></div>`;
  }).join('');
  $('nearbyItems').querySelectorAll('[data-collect-box]').forEach((button) => button.addEventListener('click', async () => {
    const result = await collectItemBox(state.roomCode, state.uid, button.dataset.collectBox);
    if (result.ok) { Sound.item(); haptic([25,30,40]); toast('Cache gesichert', '+10 Credits hinzugefügt.', 'success'); }
    else toast('Cache nicht erreichbar', result.reason, 'warn');
  }));
}

function renderLeaderboard() {
  const players = Object.values(state.room.players || {}).slice().sort((a,b) => {
    const scoreA = Number(a.score)||0;
    const scoreB = Number(b.score)||0;
    return scoreB - scoreA;
  });
  $('leaderboard').innerHTML = players.map((player,index) => {
    const role = player.role === 'seeker' ? (player.status === 'infected' ? 'INFIZIERT' : 'SEEKER') : player.role === 'hider' ? 'AKTIV / HIDER' : player.role === 'spectator' ? 'GEFANGEN' : player.status || 'LOBBY';
    const pct = clamp((Number(player.coins)||0) / 100 * 100, 0,100);
    return `<div class="lobby-player"><span class="rank-number">${String(index+1).padStart(2,'0')}</span><div class="player-avatar${avatarCosmetic(player)}">${escapeHTML((player.name||'?').slice(0,1).toUpperCase())}</div><div class="player-meta"><strong>${displayName(player)}${player.id === state.uid ? ' · DU' : ''}</strong><small>${role} · ${player.score||0} PUNKTE · ${player.hidersFound||0} FÄNGE · ${player.skillsUsed||0} SKILLS</small><div class="rank-bar"><span style="width:${pct}%"></span></div></div><span class="player-tag">${player.coins || 0} ◈</span></div>`;
  }).join('');
}

function renderRoundResults(room) {
  const awards=room.roundAchievements||[]; const results=room.roundResults||[];
  const roundId=room.roundId||room.startedAt||'current';
  if(state.lastTracksRoundId!==roundId) { state.lastTracksRoundId=roundId; drawRoundTracks(roundId,room.roundTracks,room.players); }
  $('roundAwards').innerHTML=awards.map((award,i)=>{const winner=room.players?.[award.playerId];return `<div class="award-chip" style="animation-delay:${i*90}ms"><strong>🏅 ${escapeHTML(award.title)}</strong><small>${escapeHTML(winner?.name||'Operative')} · ${escapeHTML(award.detail)}</small></div>`}).join('')||'<p class="muted">Noch keine Auszeichnungen in dieser Runde.</p>';
  $('roundLeaderboard').innerHTML=`<h3>Runden-Bestenliste</h3>${results.map((player,i)=>`<div class="round-result-row" style="animation-delay:${i*55}ms"><span class="rank-number">${String(i+1).padStart(2,'0')}</span><div><strong>${escapeHTML(player.name||'Operative')}</strong><small>${player.hidersFound||0} Fänge · ${player.skillsUsed||0} Skills · ${Math.floor((player.longestStaySeconds||0)/60)} Min. am selben Ort</small></div><b>${player.score||0} P</b></div>`).join('')}`;
}

function selectTab(tabId) {
  state.currentTab = tabId;
  document.querySelectorAll('.game-tab').forEach((button) => {
    const active = button.dataset.tab === tabId;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-content').forEach((panel) => {
    const active = panel.id === tabId;
    panel.classList.toggle('hidden', !active);
    panel.classList.toggle('active', active);
  });
  if (tabId === 'mapTab') invalidateMapSize();
  Sound.click();
}

function startGPSWatch() {
  if(state.watchId!==null||!state.gpsAuthorized||!state.gpsWatchCallbacks||!('geolocation' in navigator)) return;
  try {
    const {onSuccess,onError}=state.gpsWatchCallbacks;
    // Reuse a recent browser GPS fix for a short window to reduce repeated
    // high-power sensor wakes while keeping game actions on fresh positions.
    state.watchId=navigator.geolocation.watchPosition(onSuccess,onError,{enableHighAccuracy:true,timeout:18000,maximumAge:5000});
  } catch(error) { console.warn('GPS watch could not start',error); }
}

async function requestGPS() {
  if (!state.roomCode) return;
  if (!('geolocation' in navigator)) { toast('GPS nicht verfügbar', 'Dieser Browser stellt keine Standortfunktion bereit.', 'danger'); return; }
  if (state.watchId !== null) { toast('GPS aktiv', 'Dein Standort wird bereits aktualisiert.', 'info', 2000); return; }
  if (state.gpsPending) return;
  state.gpsPending = true;
  $('gpsBtn').textContent = 'GPS wird gesucht…';
  const requestedCode=state.roomCode;
  const onSuccess = async (position) => {
    if (state.roomCode !== requestedCode || !state.uid) return;
    state.gpsAuthorized=true;
    try { state.ownLocation = makeLocationSample(position,now()); }
    catch (error) { state.gpsPending=false; state.gpsError='GPS-Messung ungültig'; console.warn('Invalid GPS sample',error); return; }
    if (!state.connected) state.gpsSyncStatus='offline';
    else if (state.gpsSyncStatus!=='synced' || now()-state.lastLocationWrite>6500) state.gpsSyncStatus='syncing';
    state.gpsError = null;
    state.gpsPending = false;
    $('gpsBtn').textContent = '◎ GPS verbunden';
    $('mapNotice').classList.add('hidden');
    centerMap(state.ownLocation);
    if (state.connected && now() - state.lastLocationWrite > 6500) {
      state.lastLocationWrite = now();
      try { await updatePlayerLocation(state.roomCode, state.uid, state.ownLocation); state.gpsSyncStatus='synced'; }
      catch (error) {
        state.gpsSyncStatus='error'; console.warn('Could not sync GPS', error);
        if(error.code==='RESTRICTED_AREA') toast('Sperrzone aktiv',error.message,'warn',5000);
        else if(error.code==='RELOCATION_REQUIRED') toast('Abstand noch nicht erreicht',error.message,'warn',5000);
        else toast('GPS-Synchronisierung fehlgeschlagen', 'Dein Standort ist nur auf diesem Gerät aktuell; servergeprüfte Aktionen warten auf die Verbindung.', 'warn');
      }
    }
    if (state.room) {
      updateMap(state.room, state.uid, state.ownLocation, currentRole(),state.gpsSyncStatus);
      renderNearbyItems();
    }
    const notice = $('mapNotice');
    notice.classList.add('hidden');
  };
  const onError = (error) => {
    state.gpsPending = false;
    state.gpsAuthorized=false; state.gpsWatchCallbacks=null;
    state.ownLocation = null; state.zone = null; state.gpsError = error?.code === 1 ? 'GPS verweigert' : 'GPS nicht verfügbar';
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    $('gpsBtn').textContent = '◎ GPS erneut versuchen';
    const message = error?.code === 1 ? 'Standortzugriff verweigert. Erlaube Standortzugriff in den Browser-Einstellungen.' : error?.code === 2 ? 'Dein Standort ist aktuell nicht verfügbar. Prüfe GPS und Netzempfang.' : 'Die Standortabfrage hat zu lange gedauert. Bitte erneut versuchen.';
    toast('GPS konnte nicht aktiviert werden', message, 'warn', 6000);
  };
  try {
    // getCurrentPosition presents a permission prompt only after the user's explicit click.
    state.gpsWatchCallbacks={onSuccess,onError};
    navigator.geolocation.getCurrentPosition(onSuccess, onError, { enableHighAccuracy:true, timeout:14000, maximumAge:2000 });
    if(['hide','playing'].includes(state.room?.phase)) startGPSWatch();
  } catch (error) { onError(error); }
}

async function copyRoomCode() {
  const code = state.roomCode || state.room?.code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    toast('Raumcode kopiert', code, 'success', 1800);
  } catch {
    openModal({ title:'Raumcode teilen', body:`<p class="modal-copy">Kopiere diesen Code und teile ihn mit den Mitspielenden:</p><div class="puzzle-code" style="letter-spacing:.18em">${escapeHTML(code)}</div>`, actions:[{label:'Schließen',variant:'button-primary'}] });
  }
}

function confirmLeaveRoom() {
  openModal({ kicker:'MISSION CONTROL', title:'Raum verlassen?', body:'<p class="modal-copy">Du verlässt den Raum. Wenn der Host geht, wird der Raum für alle geschlossen.</p>', actions:[
    {label:'Bleiben',variant:'button-secondary'},
    {label:'Verlassen',variant:'button-danger',onClick:async()=>{
      const code = state.roomCode;
      try { await leaveRoom(code,state.uid); }
      catch (error) { toast('Verlassen fehlgeschlagen', error.message, 'danger'); return; }
      localExit();
    }}
  ]});
}

function localExit() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  clearTimeout(state.radiusSaveTimer);
  state.unsubscribe?.(); state.unsubscribe = null;
  if (state.watchId !== null && 'geolocation' in navigator) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.gpsAuthorized=false; state.gpsWatchCallbacks=null;
  clearInterval(state.taskProgressTimer);
  releaseRoundPhotos();
  state.roomCode = null; state.room = null; state.ownLocation = null;
  state.lastTracksRoundId=null; clearRoundTracks();
  $('createRoomBtn').disabled=false; $('joinRoomBtn').disabled=false;
  resetMap(); resetLobbyMap(); state.zone = null;
  state.lastAnnouncementId = null; state.lastSeekerSideAnnouncementId = null; state.seenCatchRequest = null;
  Sound.stopTension(); closeModal(); showGameState();
}

function handleAnnouncement(room) {
  const announcement = room.announcement;
  if (!announcement) return;
  if (state.lastAnnouncementId === null) { state.lastAnnouncementId = announcement.id; return; }
  if (announcement.id === state.lastAnnouncementId) return;
  state.lastAnnouncementId = announcement.id;
  if (Number(announcement.createdAt || 0) < state.subscriptionStartedAt - 1500) return;
  const isTargeted = announcement.type === 'private' && announcement.targetId === state.uid;
  const isGlobal = announcement.type === 'global' || announcement.type === 'system';
  if (!isTargeted && !isGlobal) return;
  if (announcement.type === 'system' && !['countdown','reveal','hide','playing','finished'].includes(room.phase)) return;
  const danger = /CAPTURED|INFECTED|LOCKDOWN|TRAP|SHIELD/.test(announcement.title || '');
  const success = /SECURED|COMPLETE|ACQUIRED|BONUS/.test(announcement.title || '');
  toast(announcement.title || 'MISSION UPDATE', announcement.message || '', danger ? 'danger' : success ? 'success' : 'info', 4800);
  if (/CAPTURED|INFECTED|LOCKDOWN|CATCH CONFIRMATION|SPRINT ALARM/.test(announcement.title || '')) { Sound.alert(); haptic([25,40,25]); }
  else if (/SECURED|COMPLETE|ACQUIRED/.test(announcement.title || '')) { Sound.item(); haptic(25); }
  else Sound.click();
  if(announcement.title==='PLAYER CAPTURED') {
    if(announcement.actorId===state.uid) showMoment('Fang bestätigt',announcement.message,'catch','⊕',3000);
    else if(announcement.targetId===state.uid) showMoment('Du wurdest gefunden',announcement.message,'caught','⊗',3200);
    else showMoment('Operative gefunden',announcement.message,'catch','⊕',2600);
  }
}

function handleEffects(room) {
  const self = room.players?.[state.uid];
  if (!self) return;
  if (getBackendMode() !== 'worker' && self.effects?.trackerUntil && self.effects.trackerUntil <= now()) {
    // Clear expired local effects once on the user's own transaction.
    mutateRoom(state.roomCode, (current) => {
      const player = current.players?.[state.uid];
      if (!player?.effects || (player.effects.trackerUntil || 0) > now()) return null;
      delete player.effects.trackerUntil; delete player.effects.trackerTarget; delete player.effects.compassUntil;
      return current;
    }).catch(() => {});
  }
  if (room.announcementForSeeker?.targetId === state.uid && room.announcementForSeeker.id !== state.lastSeekerSideAnnouncementId) {
    state.lastSeekerSideAnnouncementId = room.announcementForSeeker.id;
    toast(room.announcementForSeeker.title, room.announcementForSeeker.message, 'warn');
  }
}

function openCatchPicker() {
  const candidates = activePlayers().filter((player) => player.role === 'hider' && player.id !== state.uid);
  if (!candidates.length) { toast('Keine Hider verfügbar', 'Alle Hider wurden bereits gefangen oder sind nicht aktiv.', 'warn'); return; }
  openModal({ kicker:'TARGET ACQUISITION', title:'Hider gefangen melden', body:`<p class="modal-copy">Wähle den Hider, den du gerade tatsächlich berührt hast. Beide Geräte brauchen eine höchstens 15 Sekunden alte GPS-Messung mit maximal 60 m Ungenauigkeit. Der Fang zählt nur bei höchstens 8 m GPS-Abstand. Der Fang wird sofort registriert; der Hider muss nichts bestätigen.</p><div class="modal-option-list">${candidates.map((player) => `<button type="button" class="modal-option" data-catch-target="${escapeHTML(player.id)}"><span class="player-avatar${avatarCosmetic(player)}">${escapeHTML(player.name.slice(0,1).toUpperCase())}</span><span><strong>${displayName(player)}</strong><small>Ausgewählte Begegnung</small></span></button>`).join('')}</div><div class="safety-copy">GPS allein beweist keinen Fang. Nur bei tatsächlicher Berührung melden und in öffentlichen, sicheren Bereichen spielen.</div>`, actions:[{label:'Abbrechen',variant:'button-secondary'}] });
  $('modalBody').querySelectorAll('[data-catch-target]').forEach((button) => button.addEventListener('click', async () => {
    const targetId = button.dataset.catchTarget;
    closeModal();
    let result;
    try {
      const location=await getFreshCatchLocation();
      state.ownLocation=location;
      state.gpsSyncStatus='syncing';
      await updatePlayerLocation(state.roomCode,state.uid,location);
      state.lastLocationWrite=now();
      state.gpsSyncStatus='synced';
      result=await requestCatch(state.roomCode,state.uid,targetId);
    }
    catch(error) {
      const message=error?.message==='FRESH_GPS_REQUIRED'?'GPS beider Spieler muss aktiv sein; Messungen dürfen höchstens 15 Sekunden alt und maximal 60 m ungenau sein. Bitte GPS aktivieren und erneut versuchen.':error?.message==='CATCH_RANGE_REQUIRED'?'GPS liegt außerhalb des Genauigkeitsbereichs. Geht näher zusammen und versucht es erneut.':error?.message||'Bitte GPS aktivieren und erneut versuchen.';
      toast('Fang nicht ausgeführt',message,'warn'); return;
    }
    if (result) { Sound.alert(); toast('Fang ausgeführt', 'Der Fang wurde sofort registriert. Ein aktiver Schild kann ihn abwehren.', 'success'); }
    else toast('Fang nicht ausgeführt', 'Spielerstatus, frische GPS-Messungen und Nähe prüfen. Ein Hider muss nichts bestätigen.', 'warn');
  }));
}

function getFreshCatchLocation() {
  const current=state.ownLocation;
  if(current&&now()-current.measuredAt<=10000&&current.accuracy<=60) return Promise.resolve(current);
  if(!navigator.geolocation) return Promise.reject(new Error('GPS ist auf diesem Gerät nicht verfügbar.'));
  return new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(position=>{
    try {
      const location=makeLocationSample(position,now());
      if(location.accuracy>60) throw new Error('GPS ist noch zu ungenau. Bitte kurz warten und erneut versuchen.');
      resolve(location);
    } catch(error) { reject(error); }
  },error=>reject(new Error(error?.code===1?'Erlaube GPS im Browser für den Fang.':'GPS ist gerade nicht verfügbar. Bitte erneut versuchen.')),{enableHighAccuracy:true,timeout:15000,maximumAge:1500}));
}

function openSkillPicker() {
  const self = getSelf();
  if (!self) return;
  const inv = self.inventory || [];
  if (!inv.length) { toast('Arsenal leer', 'Kaufe Skills oder sammle Signal Caches, um neue Fähigkeiten zu erhalten.', 'warn'); selectTab('shopTab'); return; }
  openModal({ kicker:'ARSENAL / SELECT SKILL', title:'Fähigkeit einsetzen', body:`<p class="modal-copy">Wähle einen Skill aus deinem Inventar.</p><div class="modal-option-list">${inv.map((id,index) => `<button type="button" class="modal-option" data-inventory-index="${index}"><span class="player-avatar">${SKILL_ICONS[id] || '◇'}</span><span><strong>${escapeHTML(SKILLS[id]?.short || id)}</strong><small>${escapeHTML(SKILLS[id]?.action || 'Einmalige Fähigkeit')}</small></span></button>`).join('')}</div>`, actions:[{label:'Abbrechen',variant:'button-secondary'}] });
  $('modalBody').querySelectorAll('[data-inventory-index]').forEach((button) => button.addEventListener('click', () => useSkillFromInventory(null, Number(button.dataset.inventoryIndex))));
}

async function useSkillFromInventory(skillId=null, index=null) {
  const inventory = getSelf()?.inventory || [];
  const id = skillId || inventory[index ?? 0];
  if (!id || !SKILLS[id]) { toast('Kein Skill vorhanden', 'Wähle erst eine verfügbare Fähigkeit.', 'warn'); return; }
  closeModal();
  if (id === 'decoy') { startDecoyPlacement(); return; }
  if (id === 'sweeper' && !state.ownLocation && !getSelf()?.location) { toast('GPS erforderlich', 'Aktiviere deinen Standort, damit Fallen in deiner Nähe entfernt werden können.', 'warn'); return; }
  const result = await activateSkill(state.roomCode,state.uid,id);
  if (result.ok) { Sound.success(); haptic([20,25,20]); toast('Fähigkeit aktiviert', `${SKILLS[id].short} wurde eingesetzt.`, 'success'); }
  else toast('Fähigkeit nicht verfügbar', result.reason, 'warn');
}

function startDecoyPlacement() {
  closeModal();
  selectTab('mapTab');
  if (!beginMapPlacement(async (point) => {
    const center=state.room?.settings?.center;
    const maxRange=Math.min(Number(state.room?.settings?.radius)||500,skillTuning('decoy',state.room?.settings).decoyRange);
    if (!center || distanceMeters(point,center)>maxRange) { toast('Zu weit entfernt','Tippe innerhalb des markierten Spielfeldbereichs auf die Karte.','warn'); startDecoyPlacement(); return; }
    try {
      const result=await activateSkill(state.roomCode,state.uid,'decoy',{location:point});
      if (result.ok) { Sound.success(); haptic([20,25,20]); toast('Täusch-Marker platziert','Der Marker ist 30 Sekunden lang sichtbar.','success'); }
      else toast('Täusch-Ping fehlgeschlagen',result.reason,'warn');
    } catch(error) { toast('Täusch-Ping fehlgeschlagen',error.message||'Verbindung prüfen.','warn'); }
  })) { toast('Karte nicht bereit','Öffne zuerst die Spielkarte und versuche es erneut.','warn'); return; }
  toast('Platzierung aktiv','Tippe oder klicke auf einen sicheren Ort innerhalb der Zone.','info',5000);
}

async function startTask(kind) {
  if (getBackendMode() !== 'worker') { toast('Sichere Aufgabe nicht verfügbar','Aufgaben mit GPS-Nachweis benötigen das autorisierte Worker-Backend.','warn'); return; }
  if (getSelf()?.taskCooldownUntil > now()) { toast('Cooldown aktiv',`Noch ${Math.ceil((getSelf().taskCooldownUntil-now())/1000)} s warten.`,'warn'); return; }
  try {
    const challenge=(await workerCommand(state.roomCode,'beginTask',{kind})).result;
    state.activeTaskId=challenge.id;
    if(kind==='closecall') {
      selectTab('mapTab');
      toast('Mutprobe läuft','+1 Punkt pro bestätigter Sekunde innerhalb von 15 m, höchstens 60 Sekunden. Nur ein Versuch pro Runde.','info',6500);
      return;
    }
    if(kind==='visit') {
      selectTab('mapTab');
      if(challenge.targetLocation) centerMap(challenge.targetLocation);
      toast('Zielpunkt markiert','Gehe zum leuchtenden Zielmarker. Die Aufgabe wird automatisch abgeschlossen, sobald dein aktuelles GPS dich innerhalb von 10 m erkennt.','info',6500);
      return;
    }
    const escapedPrompt=escapeHTML(challenge.prompt || 'Finde den Zielpunkt auf der Karte.');
    const body=kind==='cipher'
      ? `<p class="modal-copy">${escapedPrompt}</p><label class="modal-field-label" for="taskAnswer">3-stelliger Tresorcode</label><input id="taskAnswer" class="modal-input" type="text" inputmode="numeric" pattern="[0-9]{3}" autocomplete="off" maxlength="3" minlength="3" autocapitalize="off" spellcheck="false" placeholder="000" aria-label="3-stelliger Tresorcode"><p id="cipherAttempts">Drei Versuche. Der Cooldown startet erst nach dem dritten Fehlversuch.</p>`
      : kind==='scan'
      ? `<p class="modal-copy">Gehe zu dem sicheren, öffentlichen Signal Cache, den der Server für dich ausgewählt hat. Er wird auf deiner Karte markiert. Nähe innerhalb von 10 m erforderlich.</p><p id="scanTaskStatus">Cache-Scan läuft · 120 Sekunden</p>`
      : kind==='proximity'
      ? `<p class="modal-copy">Suche selbstständig nach einem aktiven Hider. Der Server bestätigt die Aufgabe, wenn du auf 10 m herankommst; du bekommst keine fremde GPS-Position angezeigt.</p><p>Verbleibende Zeit: 120 Sekunden</p>`
      : kind==='visit'
      ? `<p class="modal-copy">Gehe zum geheimen Punkt in der Zone. Das Ziel erscheint auf deiner Karte. Bleib in einem sicheren, öffentlichen Bereich.</p><p id="visitTaskStatus">Zielsuche läuft · 120 Sekunden</p>`
      : kind==='photo'
      ? `<p class="modal-copy">Fotografiere dein Versteck, ohne andere Personen aufzunehmen. Das Bild wird im Browser verkleinert und Metadaten werden vor dem Speichern entfernt. Es ist für das Suchteam sichtbar und wird beim Rundenende gelöscht. Bleibe danach drei Minuten innerhalb von 10 m: +45 Credits bei Erfolg, −15 Punkte bei bestätigtem Verlassen oder Abbruch. GPS-Lücken starten die Haltezeit neu, ohne Punktabzug.</p><label class="modal-field-label" for="taskPhoto">Kamera oder Bild auswählen</label><input id="taskPhoto" class="modal-input" type="file" accept="image/*" capture="environment"><p>Das Foto wird automatisch in ein kleines JPEG umgewandelt. Es bleibt auf die laufende Runde beschränkt.</p><p id="photoUploadStatus" role="status" aria-live="polite"></p>`
      : `<p class="modal-copy">Halte deinen Standort 60 Sekunden lang innerhalb von 10 m. GPS-Lücken über 10 Sekunden, zu ungenaue Messungen oder Bewegung beenden den Versuch.</p><p id="stayTaskStatus">Verbleibende Zeit: 60 s</p>`;
    const titles={cipher:'Tresorcode knacken',visit:'Geheimer Zielpunkt',photo:'Versteck fotografieren',stay:'Versteck halten',scan:'Signal Cache scannen',proximity:'Hider-Signal aufspüren'};
    openModal({kicker:'FIELD CHALLENGE',title:titles[kind]||'Feldaufgabe',body,closeable:['scan','proximity'].includes(kind),actions:[
      {label:'Abbrechen',variant:'button-secondary',onClick:async()=>{ await workerCommand(state.roomCode,'failTask',{taskId:challenge.id}); clearInterval(state.taskProgressTimer); }},
      ...(kind==='cipher'?[{label:'Antwort prüfen',variant:'button-primary',keepOpen:true,onClick:async()=>{
        const answer=$('taskAnswer').value.trim();
        if(!/^\d{3}$/.test(answer)) { toast('Code prüfen','Gib genau drei Ziffern ein.','warn'); return; }
        try {
          await completeTask(state.roomCode,state.uid,'code',{id:challenge.id,answer});
          closeModal(); toast('Aufgabe geschafft','Belohnung wurde gutgeschrieben.','success');
        } catch(error) {
          if(error.code!=='WRONG_ANSWER') throw error;
          $('taskAnswer').value='';
          if(error.attemptsRemaining>0) {
            $('cipherAttempts').textContent=`Falscher Code. Noch ${error.attemptsRemaining} ${error.attemptsRemaining===1?'Versuch':'Versuche'}.`;
            $('taskAnswer').focus({preventScroll:true});
            toast('Code stimmt noch nicht',error.message,'warn',2500);
          } else {
            closeModal();
            toast('Versuche aufgebraucht',error.message,'warn',5000);
          }
        }
      }}]:['visit','scan','proximity'].includes(kind)?[{label:kind==='scan'?'Cache scannen':kind==='proximity'?'Nähe bestätigen':'Ich bin am Ziel',variant:'button-primary',keepOpen:true,onClick:async()=>{
        await completeTask(state.roomCode,state.uid,kind,{id:challenge.id}); closeModal(); toast('Aufgabe geschafft','Belohnung wurde gutgeschrieben.','success');
      }}]:kind==='photo'?[{label:'Foto senden',variant:'button-primary',keepOpen:true,onClick:async()=>{
        const file=$('taskPhoto')?.files?.[0]; if(!file) { toast('Foto fehlt','Nimm ein Foto auf oder wähle ein Bild aus.','warn'); return; }
        const button=$('modalActions').querySelector('.button-primary'),status=$('photoUploadStatus');
        if(button) button.disabled=true;
        try {
          if(status) status.textContent='Foto wird verkleinert und bereinigt …';
          const image=await compressRoundPhoto(file);
          if(status) status.textContent='Foto wird sicher an die Runde übertragen …';
          await workerCommand(state.roomCode,'submitPhoto',{taskId:challenge.id,image});
          closeModal(); selectTab('mapTab'); toast('Foto gespeichert · halte dein Versteck','Bleibe drei Minuten innerhalb von 10 m. Fortschritt wird automatisch geprüft. Verlassen: −15 Punkte.','info',6500);
        } catch(error) {
          const serverRejected=['INVALID_PHOTO','INVALID_CHALLENGE','TASK_EXPIRED'].includes(error.code);
          if(serverRejected) closeModal();
          else if(status) status.textContent=error.message||'Foto konnte nicht verarbeitet werden. Wähle ein anderes Bild und versuche es erneut.';
          toast(serverRejected?'Foto-Aufgabe fehlgeschlagen':'Foto konnte nicht gesendet werden',error.message||'Bitte versuche es mit einem JPEG- oder PNG-Foto erneut.',serverRejected?'warn':'danger',6000);
        } finally { if(button&&$('modalRoot')&&!$('modalRoot').classList.contains('hidden')) button.disabled=false; }
      }}]:[{label:'60 Sekunden gehalten',variant:'button-primary',keepOpen:true,onClick:async()=>{
        await completeTask(state.roomCode,state.uid,'stay',{id:challenge.id}); closeModal(); toast('Versteck gehalten','Belohnung wurde gutgeschrieben.','success');
      }}])
    ]});
    if(kind==='cipher') $('taskAnswer').focus();
    if(kind==='stay') state.taskProgressTimer=window.setInterval(()=>{
      const el=$('stayTaskStatus'); if(!el) {clearInterval(state.taskProgressTimer);return;}
      const left=Math.max(0,60-Math.floor((now()-(getSelf()?.activeTask?.progressSince || now()))/1000)); el.textContent=`Verbleibende Zeit: ${left} s`;
      $('modalActions').querySelector('.button-primary').disabled=left>0;
    },500);
  } catch(error) { toast('Aufgabe fehlgeschlagen',error.message,'warn'); }
}
async function refreshRoomAfterRoundAction() {
  const room=await getRoom(state.roomCode);
  if(room) { state.room=room; renderGame(room); }
}

async function restartSamePlayersRound() {
  if (!isHost()) { toast('Host erforderlich','Nur der Host kann die nächste Runde starten.','warn'); return; }
  const button=$('newRoundBtn');if(button) button.disabled=true;
  try {
    await workerCommand(state.roomCode,'restartRound');
    await refreshRoomAfterRoundAction();
    toast('Neue Runde startet','Die bisherigen Spieler bleiben im Raum; Rollen und Rundendaten werden erneuert.','success');
  } catch(error) { toast('Sofort-Neustart fehlgeschlagen',error.message,'danger'); }
  finally { if(button) button.disabled=false; }
}

async function returnToLobbyForSettings() {
  if (!isHost()) { toast('Host erforderlich','Nur der Host kann die nächste Runde vorbereiten.','warn'); return; }
  const button=$('postRoundSettingsBtn');if(button) button.disabled=true;
  try {
    await workerCommand(state.roomCode,'newRound');
    await refreshRoomAfterRoundAction();
    toast('Lobby ist bereit','Dieselben Spieler bleiben im Raum. Prüfe die Einstellungen und starte danach.','success');
  } catch(error) { toast('Lobby konnte nicht geöffnet werden',error.message,'danger'); }
  finally { if(button) button.disabled=false; }
}

function renderRoundPhotoGallery(room,role) {
  const gallery=$('roundPhotoGallery'); if(!gallery) return;
  gallery.replaceChildren();
  const photos=role==='seeker' && room.phase==='playing' && Array.isArray(room.roundPhotos) ? room.roundPhotos : [];
  gallery.classList.toggle('hidden',photos.length===0);
  if(!photos.length) return;
  const heading=document.createElement('strong'); heading.textContent='Hider-Fotos dieser Runde'; gallery.appendChild(heading);
  const roundId=room.roundId || room.startedAt || 'current';
  for(const photo of photos) {
    if(!/^[A-Za-z0-9_-]{4,128}$/.test(photo.id||'')) continue;
    const key=`${roundId}:${photo.id}`; const figure=document.createElement('figure');
    const image=document.createElement('img'); image.alt=`Versteckfoto von ${photo.name}`; image.loading='lazy';
    const caption=document.createElement('figcaption'); caption.textContent=photo.name;
    const url=state.roundPhotoUrls.get(key);
    if(url) image.src=url;
    else {
      caption.textContent=state.roundPhotoFailures.get(key)>now() ? `${photo.name} · Foto vorübergehend nicht verfügbar` : `${photo.name} · Foto wird geladen`;
      if(!state.roundPhotoLoads.has(key) && (state.roundPhotoFailures.get(key)||0)<=now()) {
        state.roundPhotoLoads.add(key);
        fetchRoundPhoto(state.roomCode,photo.id).then(blob=>{
          const active=state.room, stillAvailable=active?.phase==='playing' && (active.roundId || active.startedAt || 'current')===roundId && active.roundPhotos?.some(item=>item.id===photo.id);
          if(!stillAvailable) return;
          state.roundPhotoUrls.set(key,URL.createObjectURL(blob));
          renderRoundPhotoGallery(active,currentRole());
        }).catch(error=>{state.roundPhotoFailures.set(key,now()+30000);console.warn('Rundenfoto konnte nicht geladen werden:',error.message);}).finally(()=>state.roundPhotoLoads.delete(key));
      }
    }
    figure.append(image,caption); gallery.appendChild(figure);
  }
}

function releaseRoundPhotos() {
  for(const url of state.roundPhotoUrls.values()) URL.revokeObjectURL(url);
  state.roundPhotoUrls.clear(); state.roundPhotoLoads.clear(); state.roundPhotoFailures.clear();
}


function stopShakeChallenge() {
  if (state.shakeTimer) window.clearTimeout(state.shakeTimer);
  state.shakeTimer = null;
  if (state.shakeHandler) window.removeEventListener('devicemotion',state.shakeHandler);
  state.shakeHandler = null;
}

function tick() {
  const room = state.room;
  if (!room || !state.roomCode) return;
  const self=getSelf();
  renderSpecialNotices(self);
  const cooldownLeft=Math.max(0,Math.ceil(((Number(self?.taskCooldownUntil)||0)-now())/1000));
  const tasksUnavailable=getBackendMode()!=='worker';
  const cooldown=$('taskCooldown');
  const backendNotice=$('taskBackendNotice');
  if(backendNotice) { backendNotice.classList.toggle('hidden',!tasksUnavailable); if(tasksUnavailable) backendNotice.textContent='Servergeprüfte Aufgaben sind gesperrt, bis Cloudflare Worker/D1 eingerichtet und WORKER_URL gesetzt ist.'; }
  if (cooldown) { cooldown.textContent=cooldownLeft ? `Aufgaben-Cooldown: ${cooldownLeft} s` : ''; cooldown.classList.toggle('hidden',!cooldownLeft); }
  const hiderTasks=$('hiderTasks'),seekerTasks=$('seekerTasks');
  hiderTasks?.classList.toggle('hidden',self?.role!=='hider');
  seekerTasks?.classList.toggle('hidden',self?.role!=='seeker');
  const roleHint=$('taskRoleHint');
  if(roleHint) roleHint.textContent=self?.role==='hider'?'Hider-Aufträge bringen Credits für Verstecken, Navigation und Beweise.':self?.role==='seeker'?'Seeker-Aufträge: sichere Signal Caches scannen oder einen Hider im Suchradius aufspüren.':'Aufgaben sind während deiner Zuschauerrolle nicht verfügbar.';
  const activeTask=self?.activeTask,taskRunning=activeTask&&!activeTask.failed&&!activeTask.completed;
  const canStartTask=!tasksUnavailable&&!cooldownLeft&&!taskRunning&&canUseGame();
  for (const id of ['startTaskBtn','visitTaskBtn','stayTaskBtn','photoTaskBtn','closeCallTaskBtn']) if ($(id)) $(id).disabled=!canStartTask||self?.role!=='hider';
  if($('closeCallTaskBtn')) { $('closeCallTaskBtn').disabled=!canStartTask||self?.role!=='hider'||room.phase!=='playing'||Boolean(self?.closeCallUsed); $('closeCallTaskBtn').textContent=self?.closeCallUsed?'Diese Runde bereits genutzt':'Mutprobe starten →'; }
  if($('photoTaskBtn')&&room.phase==='playing'&&timerSeconds()<180) { $('photoTaskBtn').disabled=true; $('photoTaskBtn').title='Für die Fotoaufgabe müssen mindestens drei Minuten übrig sein.'; }
  else if($('photoTaskBtn')) $('photoTaskBtn').removeAttribute('title');
  if(activeTask?.failed&&activeTask.failureReason) { $('taskCooldown').classList.remove('hidden'); $('taskCooldown').textContent=`${activeTask.failureReason}${cooldownLeft?` Cooldown: ${cooldownLeft} s`:''}`; }
  else if(activeTask?.kind==='closecall'&&activeTask.completed) { $('taskCooldown').classList.remove('hidden'); $('taskCooldown').textContent=`Mutprobe beendet: +${activeTask.pointsAwarded||0} Punkte. Einmaliger Versuch verbraucht.${cooldownLeft?` Cooldown: ${cooldownLeft} s`:''}`; }
  const isSeeker=self?.role==='seeker',liveSearch=room.phase==='playing'&&isSeeker&&canStartTask;
  const activeBoxes=Object.values(room.itemBoxes||{}).some(box=>!box.collected);
  const activeHiders=Object.values(room.players||{}).some(player=>player.active&&player.role==='hider');
  if($('scanTaskBtn')) $('scanTaskBtn').disabled=!liveSearch||!activeBoxes;
  if($('proximityTaskBtn')) $('proximityTaskBtn').disabled=!liveSearch||!activeHiders;
  state.zone = evaluateZone(state.zone, {location:state.ownLocation, center:room.settings?.center, radius:room.settings?.radius, connected:state.connected, timestamp:now()});
  const labels = {inside:'Innerhalb der Zone', warning:`Zone verlassen? Rückkehr: ${state.zone.remaining} s`, outside:getBackendMode() === 'worker' ? 'Außerhalb der Zone – Server prüft die Strafe anhand frischer Messungen.' : 'Anhaltend außerhalb – Host informieren. Keine automatische Strafe.', uncertain:'GPS ungenau – keine Strafe', stale:'GPS veraltet – keine Strafe', unavailable:state.gpsError || 'GPS nicht verfügbar', offline:'Verbindung unterbrochen – keine Strafe'};
  const gpsStatus = $('gpsStatus');
  if (gpsStatus) {
    const ageSeconds=state.ownLocation?Math.max(0,Math.floor((now()-state.ownLocation.measuredAt)/1000)):null;
    const ageLabel=ageSeconds===null?'':ageSeconds<2?' · Messung gerade eben':` · Messung ${ageSeconds} s alt`;
    gpsStatus.textContent=(getBackendMode()==='worker'&&self?.zone?.violations?`Bestätigte Zonenverstöße: ${self.zone.violations} · `:'')+labels[state.zone.status]+(state.ownLocation?` · ±${Math.round(state.ownLocation.accuracy)} m${ageLabel}`:'');
  }
  if (isHost() && state.connected && !state.advancingPhase && ['countdown','reveal','hide','playing'].includes(room.phase) && room.phaseEndsAt && now() >= room.phaseEndsAt) {
    state.advancingPhase = true;
    advanceExpiredPhase(state.roomCode, room).catch((error) => console.warn('phase advance failed', error)).finally(() => { state.advancingPhase = false; });
  }
  if (room.phase === 'playing') {
    const self = getSelf();
    if (self?.role === 'hider' && self.active && now() - state.passiveRewardAt > 25_000) {
      state.passiveRewardAt = now();
      maybePayTimeReward(state.roomCode,state.uid).catch(() => {});
    }
    // Remove expired decoys/traps on a shared transaction. Stale entries never persist indefinitely.
    if (getBackendMode() !== 'worker' && isHost() && state.connected && now() - (state.lastCleanupAt || 0) > 15_000) {
      state.lastCleanupAt = now();
      mutateRoom(state.roomCode, (current) => {
        let changed = false;
        for (const [id, decoy] of Object.entries(current.decoys || {})) if ((decoy.expiresAt || 0) <= now()) { delete current.decoys[id]; changed = true; }
        for (const [id, trap] of Object.entries(current.traps || {})) if ((trap.expiresAt || 0) <= now()) { delete current.traps[id]; changed = true; }
        for (const [id, player] of Object.entries(current.players || {})) {
          if ((player.effects?.frozenUntil || 0) && player.effects.frozenUntil <= now()) { delete player.effects.frozenUntil; changed = true; }
          if ((player.effects?.ghostUntil || 0) && player.effects.ghostUntil <= now()) { delete player.effects.ghostUntil; changed = true; }
          if ((player.effects?.silentUntil || 0) && player.effects.silentUntil <= now()) { delete player.effects.silentUntil; changed = true; }
          if ((player.effects?.seekerradarUntil || 0) && player.effects.seekerradarUntil <= now()) { delete player.effects.seekerradarUntil; changed = true; }
          if ((player.effects?.sonarUntil || 0) && player.effects.sonarUntil <= now()) { delete player.effects.sonarUntil; changed = true; }
          if ((player.effects?.sprintUntil || 0) && player.effects.sprintUntil <= now()) { delete player.effects.sprintUntil; changed = true; }
        }
        if (!changed) return null;
        return current;
      }).catch(() => {});
    }
  }
  // Refresh short-lived map effects (sonar, tracker, decoys, jammer) once per second.
  const currentSecond = Math.floor(now() / 1000);
  if (currentSecond !== state.lastMapTickSecond && !$('gameScreen').classList.contains('hidden')) {
    state.lastMapTickSecond = currentSecond;
    if (state.room && state.room.phase !== 'lobby') {
      updateMap(state.room, state.uid, state.ownLocation || getSelf()?.location, currentRole(),state.gpsSyncStatus);
      const self = getSelf();
      if (self?.effects?.frozenUntil && self.effects.frozenUntil <= now() && !$('hideFreeze').classList.contains('hidden')) renderGame();
      if (currentRole() === 'hider' && (state.room.effects?.jammerUntil || 0) <= now()) $('map').style.filter = '';
      if (currentRole() === 'hider' && (state.room.effects?.jammerUntil || 0) > now()) $('map').style.filter = 'grayscale(.8) contrast(1.25) brightness(.72)';
    }
  }
  // Keep the countdown visual in sync without rerendering every panel.
  if (!$('gameScreen').classList.contains('hidden')) {
    const second = timerSeconds();
    $('matchTimer').textContent = formatTime(second);
    $('freezeTimer').textContent = self?.effects?.frozenUntil>now() ? formatTime(Math.ceil((self.effects.frozenUntil-now())/1000)) : formatTime(second);
    const phase = room.phase;
    if (['countdown','reveal'].includes(phase) && second !== state.lastCountdownSecond) {
      state.lastCountdownSecond = second;
      if (second <= 5 && second > 0) Sound.countdown();
      if (second === 0) Sound.go();
    }
    const total = phase === 'hide' ? Number(room.settings.hideDuration) : phase === 'playing' ? Number(room.settings.gameDuration) : phase === 'countdown' ? 10 : phase === 'reveal' ? 5 : 0;
    $('timerProgress').style.width = `${total > 0 ? clamp(second / total * 100,0,100) : 0}%`;
    if (phase === 'hide' && currentRole() === 'seeker') $('freezeTimer').textContent = formatTime(second);
  }
}

startApp().catch((error) => {
  console.error(error);
  toast('App konnte nicht initialisiert werden', error?.message || 'Bitte lade die Seite neu.', 'danger', 6500);
});
