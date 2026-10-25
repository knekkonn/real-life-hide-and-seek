import { initBackend, getBackendMode, getPlayerUid, createRoom, getRoom, mutateRoom, deleteRoom, subscribeRoom, subscribeConnection } from './backend.js';
import { MAX_PLAYERS, MIN_PLAYERS } from './config.js';
import { SKILLS, SKILL_IDS, DEFAULT_SETTINGS } from './skills.js';
import {
  createRoomData, addPlayerToRoom, updateSettings, startCountdown, advanceExpiredPhase,
  maybePayTimeReward, updatePlayerLocation, requestCatch, respondToCatch, buySkill,
  activateSkill, collectItemBox, completeTask, leaveRoom
} from './game-service.js';
import { initMap, updateMap, centerMap, invalidateMapSize, resetMap } from './map.js';
import { clamp, now, formatTime, escapeHTML, randomCode, distanceMeters, Sound, haptic, setSoundEnabled } from './utils.js';

const $ = (id) => document.getElementById(id);
const state = {
  uid:null, playerName:'', roomCode:null, room:null, unsubscribe:null, connected:true,
  ownLocation:null, watchId:null, gpsPending:false, lastLocationWrite:0,
  lastAnnouncementId:null, lastSeekerSideAnnouncementId:null, subscriptionStartedAt:0, seenCatchRequest:null,
  revealDismissedPhase:null, lastCountdownSecond:null, currentTab:'mapTab',
  audioOn:true, tickHandle:null, passiveRewardAt:0, shakeHandler:null, shakeTimer:null,
  shakeCount:0, shakeTarget:10, challengeDone:false, pendingTimer:null
};

const SKILL_ICONS = { sonar:'◉',tracker:'⌖',jammer:'ϟ',sprint:'⚡',sweeper:'⌁',compass:'➤',ghost:'✧',decoy:'◈',trap:'⌗',shield:'⬡',seekerradar:'◎',silent:'♧' };
const PHASE_LABELS = { lobby:'LOBBY READY',countdown:'SYNC COUNTDOWN',reveal:'IDENTITY REVEAL',hide:'HIDE PHASE',playing:'LIVE MATCH',finished:'MISSION COMPLETE',closed:'ROOM CLOSED' };

function setConnectionBadge() {
  const badge = $('connectionBadge');
  const span = badge.querySelector('span');
  badge.classList.toggle('is-connected', state.connected && getBackendMode() === 'firebase');
  badge.classList.toggle('is-error', !state.connected);
  if (getBackendMode() === 'firebase') span.textContent = state.connected ? 'FIREBASE LIVE' : 'RECONNECTING';
  else span.textContent = 'DEMO-MODUS';
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

async function startApp() {
  try { await initBackend(); }
  catch (error) { console.warn(error); toast('Firebase nicht verbunden', 'Die App läuft im lokalen Demo-Modus. Für echte Multiplayer-Synchronisation Firebase konfigurieren.', 'warn', 6500); }
  setConnectionBadge();
  $('soundToggle').addEventListener('click', () => {
    state.audioOn = !state.audioOn;
    setSoundEnabled(state.audioOn);
    $('soundIcon').textContent = state.audioOn ? '♫' : '♪̸';
    $('soundToggle').classList.toggle('is-muted', !state.audioOn);
    if (state.audioOn) Sound.click();
    toast('Audio', state.audioOn ? 'Soundeffekte aktiviert.' : 'Soundeffekte deaktiviert.', 'info', 1800);
  });
  setSoundEnabled(true);
  $('entryForm').addEventListener('submit', (event) => event.preventDefault());
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
  $('catchBtn').addEventListener('click', openCatchPicker);
  $('activateSkillBtn').addEventListener('click', openSkillPicker);
  $('startTaskBtn').addEventListener('click', startCodeTask);
  $('startShakeBtn').addEventListener('click', startShakeChallenge);
  $('modalCloseBtn').addEventListener('click', closeModal);
  $('modalRoot').addEventListener('click', (event) => { if (event.target.hasAttribute('data-close-modal')) closeModal(); });
  $('mapRadius').addEventListener('input', (event) => {
    const radius = Number(event.target.value);
    $('mapRadiusValue').textContent = `${radius} m`;
    saveSettings({ radius });
  });
  document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => {
    const key = button.dataset.step;
    const delta = Number(button.dataset.delta);
    const current = Number(state.room?.settings?.[key] ?? DEFAULT_SETTINGS[key]);
    const min = key === 'hideDuration' ? 120 : 900;
    const max = key === 'hideDuration' ? 300 : 1800;
    saveSettings({ [key]:clamp(current + delta, min, max) });
    Sound.click();
  }));
  document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', () => saveSettings({ mode:input.value })));
  document.querySelectorAll('[data-skill]').forEach((input) => input.addEventListener('change', () => saveSettings({ skills:{ [input.dataset.skill]:input.checked } })));
  $('announcementsToggle').addEventListener('change', (event) => saveSettings({ announcements:event.target.checked }));
  $('seekerCount').addEventListener('change', (event) => saveSettings({ seekerCount:Number(event.target.value) }));
  document.querySelectorAll('.game-tab').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.modalCloseable && !$('modalRoot').classList.contains('hidden')) closeModal(); });
  subscribeConnection((connected) => { state.connected = connected; setConnectionBadge(); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker registration failed', error));
  }
  state.tickHandle = window.setInterval(tick, 500);
}

function validatePlayerName() {
  const name = $('playerName').value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 18) { toast('Codename prüfen', 'Bitte nutze 2 bis 18 Zeichen.', 'warn'); return null; }
  if (!/^[\p{L}\p{N}_ -]+$/u.test(name)) { toast('Codename ungültig', 'Erlaubt sind Buchstaben, Ziffern, Leerzeichen, Unterstriche und Bindestriche.', 'warn'); return null; }
  return name;
}

async function createLobby() {
  const name = validatePlayerName();
  if (!name) return;
  const uid = getPlayerUid();
  $('createRoomBtn').disabled = true;
  try {
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
    const room = await getRoom(code);
    if (!room || room.phase === 'closed') { toast('Raum nicht gefunden', 'Überprüfe den Code oder bitte den Host um eine neue Lobby.', 'danger'); return; }
    let failure = null;
    const updated = await mutateRoom(code, (current) => {
      const result = addPlayerToRoom(current, getPlayerUid(), name);
      if (!result.ok) { failure = result.reason; return null; }
      return current;
    });
    if (!updated) { toast('Beitritt nicht möglich', failure || 'Lobby wurde geschlossen oder konnte nicht aktualisiert werden.', 'danger'); return; }
    state.playerName = name;
    state.uid = getPlayerUid();
    state.roomCode = code;
    state.subscriptionStartedAt = now();
    attachRoomListener();
    showGameState();
    toast('Verbunden', `Du bist dem Raum ${code} beigetreten.`, 'success');
    Sound.success();
  } catch (error) {
    console.error(error);
    toast('Verbindung fehlgeschlagen', error?.message || 'Bitte erneut versuchen.', 'danger');
  } finally { $('joinRoomBtn').disabled = false; }
}

function attachRoomListener() {
  state.unsubscribe?.();
  state.unsubscribe = subscribeRoom(state.roomCode, (room) => {
    if (!room || room.phase === 'closed') {
      if (state.roomCode) toast('Raum geschlossen', 'Die Lobby ist nicht mehr verfügbar.', 'warn');
      localExit();
      return;
    }
    const priorPhase = state.room?.phase;
    state.room = room;
    const self = getSelf();
    if (self?.location && !state.ownLocation) state.ownLocation = self.location;
    showGameState();
    renderAll();
    handleAnnouncement(room);
    handleCatchRequest(room);
    handleEffects(room);
    if (priorPhase !== room.phase) onPhaseChanged(room.phase);
  }, (error) => {
    console.error('Room listener error', error);
    state.connected = false;
    setConnectionBadge();
    toast('Verbindung unterbrochen', 'Die App versucht, die Verbindung wiederherzustellen.', 'warn', 5000);
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
  if (phase === 'playing') { Sound.go(); haptic([30,50,30]); }
  if (phase === 'finished') { Sound.alert(); haptic([70,80,70]); }
}

async function saveSettings(patch) {
  if (!state.roomCode || !isHost()) return;
  try {
    await mutateRoom(state.roomCode, (room) => updateSettings(room, state.uid, patch));
  } catch (error) { toast('Einstellung nicht gespeichert', error?.message || 'Bitte erneut versuchen.', 'danger'); }
}

function renderAll() {
  if (!state.room) return;
  if (state.room.phase === 'lobby') renderLobby();
  else renderGame();
  setConnectionBadge();
}

function renderLobby() {
  const room = state.room;
  $('lobbyRoomCode').textContent = room.code || state.roomCode;
  $('hostBadge').classList.toggle('hidden', !isHost());
  $('hostSettings').classList.toggle('hidden', !isHost());
  $('guestSettingsNote').classList.toggle('hidden', isHost());
  document.querySelectorAll('#hostSettings input, #hostSettings button').forEach((input) => { input.disabled = !isHost(); });
  const settings = room.settings || DEFAULT_SETTINGS;
  const active = activePlayers();
  $('lobbyPlayerCount').textContent = `${active.length} / ${MAX_PLAYERS}`;
  $('teamProgressBar').style.width = `${Math.min(100, active.length / MAX_PLAYERS * 100)}%`;
  $('hideDurationValue').textContent = formatTime(settings.hideDuration);
  $('gameDurationValue').textContent = formatTime(settings.gameDuration);
  if (document.activeElement !== $('mapRadius')) $('mapRadius').value = settings.radius;
  $('mapRadiusValue').textContent = `${settings.radius} m`;
  $('announcementsToggle').checked = settings.announcements !== false;
  const seekerCount = Number(settings.seekerCount) || 1;
  if (document.activeElement !== $('seekerCount')) $('seekerCount').value = String(seekerCount);
  $('hiderCountValue').textContent = String(Math.max(0, active.length - seekerCount));
  $('seekerCount').querySelectorAll('option').forEach((option) => { option.disabled = Number(option.value) >= active.length; });
  if (seekerCount >= active.length) $('hiderCountValue').textContent = 'mind. 1';
  document.querySelectorAll('input[name="mode"]').forEach((input) => { input.checked = input.value === settings.mode; });
  document.querySelectorAll('[data-skill]').forEach((input) => { input.checked = settings.skills?.[input.dataset.skill] !== false; });
  $('lobbyPlayers').innerHTML = active.map((player) => `
    <div class="lobby-player"><div class="player-avatar">${escapeHTML((player.name || '?').slice(0,1).toUpperCase())}</div><div class="player-meta"><strong>${displayName(player)}${player.id === state.uid ? ' <span style="color:var(--cyan)">(DU)</span>' : ''}</strong><small>${player.isHost ? 'LOBBY HOST' : 'OPERATIVE'} · VERBUNDEN</small></div>${player.isHost ? '<span class="player-tag">★ HOST</span>' : '<span class="player-tag">READY</span>'}</div>
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
    const result = await mutateRoom(state.roomCode, (room) => {
      response = startCountdown(room, state.uid, state.ownLocation || getSelf()?.location);
      if (!response.ok) return null;
      return room;
    });
    if (!result) { toast('Einsatz konnte nicht starten', response?.reason || 'Bitte Lobby und Verbindung prüfen.', 'danger'); return; }
    Sound.go();
  } catch (error) { toast('Start fehlgeschlagen', error?.message || 'Bitte erneut versuchen.', 'danger'); }
  finally { $('startGameBtn').disabled = false; }
}

function renderGame() {
  const room = state.room;
  const self = getSelf();
  if (!self) { toast('Spieler nicht gefunden', 'Tritt dem Raum erneut bei.', 'danger'); return; }
  const phase = room.phase;
  const role = self.role || 'waiting';
  $('gameRoomCode').textContent = state.roomCode;
  $('phaseLabel').textContent = PHASE_LABELS[phase] || 'LIVE MATCH';
  $('gameModeTag').textContent = room.settings.mode === 'infected' ? 'INFECTED MODE' : 'CLASSIC MODE';
  $('phaseDot').style.background = phase === 'finished' ? 'var(--muted)' : phase === 'playing' ? 'var(--red)' : 'var(--neon)';
  $('phaseDot').style.boxShadow = phase === 'playing' ? '0 0 8px var(--red)' : '0 0 8px var(--neon)';
  $('gameGreeting').textContent = role === 'seeker' ? 'Jage die Signale.' : role === 'spectator' ? 'Beobachte das Feld.' : role === 'hider' ? 'Bleib unsichtbar.' : 'Mission bereit.';
  $('gameSubheading').textContent = phase === 'countdown' ? 'Synchronisiere dich mit deinem Team.' : phase === 'reveal' ? 'Deine Identität wird bestätigt.' : phase === 'hide' ? (role === 'seeker' ? 'Hold position. Die Hider haben Vorsprung.' : 'Finde einen sicheren, öffentlichen Ort zum Verstecken.') : phase === 'playing' ? 'Der Einsatz läuft. Nutze Skills und Signal Caches.' : 'Diese Runde ist beendet.';
  $('operativeName').textContent = self.name;
  $('operativeAvatar').textContent = (self.name || '?').slice(0,1).toUpperCase();
  $('operativeRole').textContent = role === 'seeker' ? (room.settings.mode === 'infected' && self.status === 'infected' ? 'INFIZIERT / SEEKER' : 'SEEKER') : role === 'hider' ? 'HIDER' : role === 'spectator' ? 'ZUSCHAUER' : 'BEREIT';
  $('operativeRole').className = `role-chip ${role === 'seeker' ? 'role-seeker' : role === 'spectator' ? 'role-spectator' : 'role-hider'}`;
  $('roleChip').textContent = $('operativeRole').textContent;
  $('operativeCoins').textContent = String(self.coins || 0);
  $('coinBadge').textContent = `${self.coins || 0} ◈`;
  $('shopCoinCounter').textContent = `${self.coins || 0} ◈`;
  $('operativeItems').textContent = String((self.inventory || []).length);
  const inventory = self.inventory || [];
  const activeSkill = inventory[0] ? SKILLS[inventory[0]] : null;
  $('activeSkillName').textContent = activeSkill?.short || (self.effects?.shield ? 'Schild aktiv' : 'Kein Skill bereit');
  $('activeSkillIcon').textContent = activeSkill ? (SKILL_ICONS[activeSkill.id] || activeSkill.icon) : '◇';
  $('activateSkillBtn').disabled = !canUseGame() || (!inventory.length && !self.effects?.shield);
  $('activateSkillBtn').textContent = inventory.length ? 'Fähigkeit einsetzen ↗' : 'Keine Fähigkeit bereit';
  $('activateSkillBtn').innerHTML = `${inventory.length ? 'Fähigkeit einsetzen' : 'Keine Fähigkeit bereit'} <span>↗</span>`;
  $('matchTimer').textContent = timerText();
  $('timerCaption').textContent = phase === 'hide' ? (role === 'seeker' ? 'LOCKDOWN TIMER' : 'HIDE TIMER') : ['countdown','reveal'].includes(phase) ? 'START IN' : 'MATCH TIMER';
  const totalTime = phase === 'hide' ? Number(room.settings.hideDuration) : phase === 'playing' ? Number(room.settings.gameDuration) : phase === 'countdown' ? 10 : phase === 'reveal' ? 5 : 0;
  const timeLeft = timerSeconds();
  $('timerProgress').style.width = `${totalTime > 0 ? clamp(timeLeft / totalTime * 100, 0,100) : 0}%`;
  $('freezeTimer').textContent = formatTime(timerSeconds());
  const seekerLock = phase === 'hide' && role === 'seeker';
  const empFrozen = role === 'seeker' && (self.effects?.frozenUntil || 0) > now() && phase === 'playing';
  $('hideFreeze').classList.toggle('hidden', !seekerLock && !empFrozen);
  if (empFrozen) {
    $('hideFreeze').querySelector('h2').innerHTML = 'EMP <br><span class="text-neon">LOCKDOWN.</span>';
    $('hideFreeze').querySelector('p').textContent = 'Eine digitale Falle hat dein Signal blockiert. Bewege dich nicht in Gefahr und warte auf die Freigabe.';
    $('freezeTimer').textContent = formatTime(Math.ceil((self.effects.frozenUntil - now()) / 1000));
    $('hideFreeze').querySelector('.freeze-sub').textContent = 'SIGNAL RESTORE IN PROGRESS';
  } else {
    $('hideFreeze').querySelector('h2').innerHTML = 'Bleib auf<br><span class="text-neon">Position.</span>';
    $('hideFreeze').querySelector('p').textContent = 'Die Hider bekommen einen Vorsprung. Deine Karte bleibt gesperrt, bis die Zeit abgelaufen ist.';
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
  $('mapNotice').querySelector('small').textContent = state.ownLocation ? 'Deine Position wird aktualisiert.' : 'Standort freigeben, um deine Position auf der Karte anzuzeigen.';
  const mapLocked = seekerLock || empFrozen || phase === 'countdown' || phase === 'reveal';
  const jammed = role === 'hider' && (room.effects?.jammerUntil || 0) > now();
  $('map').style.filter = jammed ? 'grayscale(.8) contrast(1.25) brightness(.72)' : '';
  $('map').style.opacity = mapLocked ? '.13' : '1';
  if (jammed && phase === 'playing') {
    $('mapCaption').textContent = `RADAR-JAMMER AKTIV · ${Math.ceil((room.effects.jammerUntil-now())/1000)} S`;
  }
  $('map').style.pointerEvents = mapLocked ? 'none' : '';
  if (mapLocked) $('mapNotice').classList.add('hidden');
  renderRoster();
  renderQuickActions();
  renderShop();
  renderNearbyItems();
  renderLeaderboard();
  if (room.phase !== 'lobby') updateMap(room, state.uid, state.ownLocation || self.location, role);
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
    return `<div class="roster-player"><div class="player-avatar">${escapeHTML((player.name||'?').slice(0,1).toUpperCase())}</div><div class="player-meta"><strong>${displayName(player)}${player.id === state.uid ? ' · DU' : ''}</strong><small>${player.isHost ? 'HOST · ' : ''}${player.status === 'left' ? 'OFFLINE' : player.active ? 'ONLINE' : 'INAKTIV'}</small></div><span class="roster-state ${statusClass}">${roleText}</span></div>`;
  }).join('');
}

function renderQuickActions() {
  const self = getSelf();
  const role = self?.role;
  const phase = state.room.phase;
  const canAct = canUseGame() && !(role === 'seeker' && phase === 'hide');
  const inventory = self?.inventory || [];
  const actions = [];
  if (role === 'seeker') {
    actions.push({icon:'◉',title:'Sonar Ping',detail:'Hider 5 Sek. orten',action:()=>useSkillFromInventory('sonar'),disabled:!canAct || !inventory.includes('sonar')});
    actions.push({icon:'⌖',title:'GPS-Tracker',detail:'Nächsten Hider verfolgen',action:()=>useSkillFromInventory('tracker'),disabled:!canAct || !inventory.includes('tracker')});
    actions.push({icon:'➤',title:'Kompass',detail:'Entferntesten Hider peilen',action:()=>useSkillFromInventory('compass'),disabled:!canAct || !inventory.includes('compass')});
  } else if (role === 'hider') {
    actions.push({icon:'✧',title:'Geist-Modus',detail:'GPS 45 Sek. verbergen',action:()=>useSkillFromInventory('ghost'),disabled:!canAct || !inventory.includes('ghost')});
    actions.push({icon:'◈',title:'Täusch-Ping',detail:'Falschen Marker setzen',action:()=>startDecoyPlacement(),disabled:!canAct || !inventory.includes('decoy')});
    actions.push({icon:'⌗',title:'EMP-Falle',detail:'Falle am Standort legen',action:()=>useSkillFromInventory('trap'),disabled:!canAct || !inventory.includes('trap') || !state.ownLocation});
  }
  actions.push({icon:'▤',title:'Field Task',detail:'Credits verdienen',action:startCodeTask,disabled:!canAct});
  $('quickActions').innerHTML = actions.map((item,index) => `<button class="quick-action" type="button" data-quick="${index}" ${item.disabled ? 'disabled' : ''}><span>${item.icon}</span><strong>${item.title}</strong><small>${item.detail}</small></button>`).join('');
  $('quickActions').querySelectorAll('[data-quick]').forEach((button,index) => button.addEventListener('click', actions[Number(button.dataset.quick)].action));
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
      const phaseAllowed = state.room.phase === 'playing' || (side === 'hider' && state.room.phase === 'hide');
      const disabled = !phaseAllowed || Number(self.coins || 0) < skill.price;
      return `<article class="shop-item"><div class="shop-item-top"><span class="shop-item-icon">${SKILL_ICONS[skill.id] || skill.icon}</span><span class="shop-price">◈ ${skill.price}</span></div><span class="shop-side-label">${side === 'seeker' ? 'SEEKER TECH' : 'HIDER TECH'}</span><h3>${escapeHTML(skill.short)}</h3><p>${escapeHTML(skill.description)}</p><button class="button button-secondary" data-buy-skill="${skill.id}" type="button" ${disabled ? 'disabled' : ''}>${phaseAllowed ? 'Kaufen' : 'Später verfügbar'} <span>→</span></button></article>`;
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
    const scoreA = (a.active ? 1000 : 0) + (Number(a.coins)||0) + (Number(a.foundItems)||0)*10 + (Number(a.tasksSolved)||0)*25;
    const scoreB = (b.active ? 1000 : 0) + (Number(b.coins)||0) + (Number(b.foundItems)||0)*10 + (Number(b.tasksSolved)||0)*25;
    return scoreB - scoreA;
  });
  $('leaderboard').innerHTML = players.map((player,index) => {
    const role = player.role === 'seeker' ? (player.status === 'infected' ? 'INFIZIERT' : 'SEEKER') : player.role === 'hider' ? 'AKTIV / HIDER' : player.role === 'spectator' ? 'GEFANGEN' : player.status || 'LOBBY';
    const pct = clamp((Number(player.coins)||0) / 100 * 100, 0,100);
    return `<div class="lobby-player"><span class="rank-number">${String(index+1).padStart(2,'0')}</span><div class="player-avatar">${escapeHTML((player.name||'?').slice(0,1).toUpperCase())}</div><div class="player-meta"><strong>${displayName(player)}${player.id === state.uid ? ' · DU' : ''}</strong><small>${role} · ${player.foundItems || 0} CACHES · ${player.tasksSolved || 0} TASKS</small><div class="rank-bar"><span style="width:${pct}%"></span></div></div><span class="player-tag">${player.coins || 0} ◈</span></div>`;
  }).join('');
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

async function requestGPS() {
  if (!state.roomCode) return;
  if (!('geolocation' in navigator)) { toast('GPS nicht verfügbar', 'Dieser Browser stellt keine Standortfunktion bereit.', 'danger'); return; }
  if (state.watchId !== null) { toast('GPS aktiv', 'Dein Standort wird bereits aktualisiert.', 'info', 2000); return; }
  if (state.gpsPending) return;
  state.gpsPending = true;
  $('gpsBtn').textContent = 'GPS wird gesucht…';
  const onSuccess = async (position) => {
    if (!state.roomCode || !state.uid) return;
    const coords = position.coords;
    state.ownLocation = { lat:coords.latitude, lng:coords.longitude, accuracy:coords.accuracy };
    state.gpsPending = false;
    $('gpsBtn').textContent = '◎ GPS verbunden';
    $('mapNotice').classList.add('hidden');
    centerMap(state.ownLocation);
    if (now() - state.lastLocationWrite > 6500) {
      state.lastLocationWrite = now();
      try { await updatePlayerLocation(state.roomCode, state.uid, state.ownLocation); }
      catch (error) { console.warn('Could not sync GPS', error); toast('GPS lokal aktiv', 'Die Position konnte noch nicht synchronisiert werden.', 'warn'); }
    }
    if (state.room) {
      updateMap(state.room, state.uid, state.ownLocation, currentRole());
      renderNearbyItems();
    }
    const notice = $('mapNotice');
    notice.classList.add('hidden');
  };
  const onError = (error) => {
    state.gpsPending = false;
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    $('gpsBtn').textContent = '◎ GPS erneut versuchen';
    const message = error?.code === 1 ? 'Standortzugriff verweigert. Erlaube Standortzugriff in den Browser-Einstellungen.' : error?.code === 2 ? 'Dein Standort ist aktuell nicht verfügbar. Prüfe GPS und Netzempfang.' : 'Die Standortabfrage hat zu lange gedauert. Bitte erneut versuchen.';
    toast('GPS konnte nicht aktiviert werden', message, 'warn', 6000);
  };
  try {
    // getCurrentPosition presents a permission prompt only after the user's explicit click.
    navigator.geolocation.getCurrentPosition(onSuccess, onError, { enableHighAccuracy:true, timeout:14000, maximumAge:2000 });
    state.watchId = navigator.geolocation.watchPosition(onSuccess, (error) => {
      if (error?.code === 1) onError(error);
    }, { enableHighAccuracy:true, timeout:18000, maximumAge:3500 });
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
  openModal({ kicker:'MISSION CONTROL', title:'Raum verlassen?', body:'<p class="modal-copy">Dein Operative wird als abgemeldet markiert. Bei einer laufenden Runde kann das nicht rückgängig gemacht werden.</p>', actions:[
    {label:'Bleiben',variant:'button-secondary'},
    {label:'Verlassen',variant:'button-danger',onClick:async()=>{
      const code = state.roomCode;
      const hostLeavingLobby = isHost() && state.room?.phase === 'lobby';
      try { await leaveRoom(code,state.uid); if (hostLeavingLobby) await deleteRoom(code); }
      catch (error) { console.warn(error); }
      localExit();
    }}
  ]});
}

function localExit() {
  state.unsubscribe?.(); state.unsubscribe = null;
  if (state.watchId !== null && 'geolocation' in navigator) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.roomCode = null; state.room = null; state.ownLocation = null;
  resetMap();
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
  const danger = /CAPTURED|INFECTED|LOCKDOWN|TRAP/.test(announcement.title || '');
  const success = /SECURED|COMPLETE|ACQUIRED|BONUS/.test(announcement.title || '');
  toast(announcement.title || 'MISSION UPDATE', announcement.message || '', danger ? 'danger' : success ? 'success' : 'info', 4800);
  if (/CAPTURED|INFECTED|LOCKDOWN|CATCH CONFIRMATION|SPRINT ALARM/.test(announcement.title || '')) { Sound.alert(); haptic([25,40,25]); }
  else if (/SECURED|COMPLETE|ACQUIRED/.test(announcement.title || '')) { Sound.item(); haptic(25); }
  else Sound.click();
}

function handleCatchRequest(room) {
  const request = room.pendingCatch;
  if (!request || request.targetId !== state.uid || request.status !== 'pending') return;
  if (state.seenCatchRequest === request.id) return;
  state.seenCatchRequest = request.id;
  const seeker = room.players?.[request.seekerId];
  openModal({ kicker:'CATCH CONFIRMATION', title:'Wurdest du gefangen?', closeable:false,
    body:`<p class="modal-copy"><strong>${displayName(seeker)}</strong> meldet eine Begegnung mit dir. Bestätige nur, wenn ihr euch tatsächlich gesehen habt.</p><div class="safety-copy">Bitte bleib in einem öffentlichen und sicheren Bereich. GPS allein ist kein Beweis für eine Gefangennahme.</div>`,
    actions:[
      {label:'Nein',variant:'button-secondary',onClick:async()=>{ await respondToCatch(state.roomCode,state.uid,false); state.seenCatchRequest=null; }},
      {label:'Ja, gefangen',variant:'button-danger',onClick:async()=>{ await respondToCatch(state.roomCode,state.uid,true); state.seenCatchRequest=null; Sound.alert(); }}
    ]
  });
}

function handleEffects(room) {
  const self = room.players?.[state.uid];
  if (!self) return;
  if (self.effects?.trackerUntil && self.effects.trackerUntil <= now()) {
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
  openModal({ kicker:'TARGET ACQUISITION', title:'Hider auswählen', body:`<p class="modal-copy">Wähle den Spieler, den du bei einer tatsächlichen Begegnung gefangen hast. Der Hider bestätigt den Fang auf seinem Gerät.</p><div class="modal-option-list">${candidates.map((player) => `<button type="button" class="modal-option" data-catch-target="${escapeHTML(player.id)}"><span class="player-avatar">${escapeHTML(player.name.slice(0,1).toUpperCase())}</span><span><strong>${displayName(player)}</strong><small>${player.location ? 'GPS aktiv' : 'GPS nicht verfügbar'}</small></span></button>`).join('')}</div><div class="safety-copy">Kein Fang allein anhand des GPS durchführen. Fangmeldungen nur bei realer Begegnung absenden.</div>`, actions:[{label:'Abbrechen',variant:'button-secondary'}] });
  $('modalBody').querySelectorAll('[data-catch-target]').forEach((button) => button.addEventListener('click', async () => {
    const targetId = button.dataset.catchTarget;
    closeModal();
    const result = await requestCatch(state.roomCode,state.uid,targetId);
    if (result) { Sound.click(); toast('Fang angefragt', 'Warte auf die Bestätigung des Hiders.', 'info'); }
    else toast('Fang konnte nicht angefragt werden', 'Der Spieler ist nicht mehr aktiv oder es läuft bereits eine Anfrage.', 'warn');
  }));
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
  const location = state.ownLocation || getSelf()?.location;
  const defaultPoint = location ? { lat:(location.lat + 0.0005).toFixed(6), lng:(location.lng + 0.0005).toFixed(6) } : { lat:'',lng:'' };
  openModal({ kicker:'DECOY PING / 30 SEC', title:'Täusch-Marker platzieren', body:`<p class="modal-copy">Setze einen Fake-Marker an einer beliebigen Koordinate. Du kannst die Karte auf einen Ort tippen und dessen Koordinaten hier einsetzen.</p><label class="modal-field-label" for="decoyLat">Breitengrad (Latitude)</label><input class="modal-input" id="decoyLat" type="number" step="any" placeholder="52.520000" value="${defaultPoint.lat}"><label class="modal-field-label" for="decoyLng">Längengrad (Longitude)</label><input class="modal-input" id="decoyLng" type="number" step="any" placeholder="13.405000" value="${defaultPoint.lng}"><p class="puzzle-hint">Beispiel: 52.5200 / 13.4050. Der Marker verschwindet nach 30 Sekunden.</p>`, actions:[
    {label:'Abbrechen',variant:'button-secondary'},
    {label:'Marker setzen',variant:'button-primary',keepOpen:true,onClick:async()=>{
      const latText = $('decoyLat')?.value?.trim() || ''; const lngText = $('decoyLng')?.value?.trim() || '';
      const lat = Number(latText); const lng = Number(lngText);
      if (!latText || !lngText || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180) { toast('Koordinaten prüfen', 'Bitte gültige GPS-Koordinaten eingeben.', 'warn'); return; }
      const result = await activateSkill(state.roomCode,state.uid,'decoy',{location:{lat,lng}});
      if (result.ok) { closeModal(); Sound.success(); toast('Täusch-Marker platziert', 'Der Marker ist 30 Sekunden lang sichtbar.', 'success'); }
      else toast('Täusch-Ping fehlgeschlagen', result.reason, 'warn');
    }}
  ]});
}

function startCodeTask() {
  const role = currentRole();
  if (!canUseGame()) { toast('Task noch gesperrt', 'Aufgaben sind während der aktiven Hider-Phase oder im Match verfügbar.', 'warn'); return; }
  const a = Math.floor(12 + Math.random()*38);
  const b = Math.floor(11 + Math.random()*41);
  const answer = a + b;
  openModal({ kicker:'LOGIC PROTOCOL / 01', title:'Code knacken', body:`<p class="modal-copy">Berechne die Prüfsumme, um den Task abzuschließen und Credits zu erhalten.</p><div class="puzzle-code">${a} + ${b} = ?</div><label class="modal-field-label" for="taskAnswer">Antwort</label><input class="modal-input" id="taskAnswer" type="number" inputmode="numeric" placeholder="Prüfsumme eingeben"><p class="puzzle-hint">Ein korrekter Code bringt 25 Credits. Mit etwas Glück wird ein zusätzlicher Skill freigeschaltet.</p>`, actions:[
    {label:'Abbrechen',variant:'button-secondary'},
    {label:'Code prüfen',variant:'button-primary',keepOpen:true,onClick:async()=>{
      const value = Number($('taskAnswer')?.value);
      if (value !== answer) { Sound.error(); toast('Code falsch', 'Versuche es erneut. Der Task bleibt offen.', 'warn'); return; }
      closeModal();
      const ok = await completeTask(state.roomCode,state.uid,'code');
      if (ok) { Sound.success(); haptic(30); toast('Task abgeschlossen', '+25 Credits gutgeschrieben.', 'success'); }
      else toast('Task nicht verfügbar', 'Die Runde ist nicht aktiv oder dein Spielerstatus hat sich geändert.', 'warn');
    }}
  ]});
  window.setTimeout(() => $('taskAnswer')?.focus(), 80);
}

async function startShakeChallenge() {
  if (!canUseGame()) { toast('Challenge nicht verfügbar', 'Aufgaben sind während einer aktiven Phase verfügbar.', 'warn'); return; }
  state.shakeCount = 0; state.challengeDone = false;
  openModal({ kicker:'MOVEMENT PROTOCOL / 02', title:'Shake Challenge', body:`<p class="modal-copy">Schüttle dein Gerät 10-mal innerhalb von 10 Sekunden. Auf Desktop kannst du die Bewegung über den Simulationsbutton auslösen.</p><div class="puzzle-code"><span id="shakeCounter">0</span> / 10</div><div class="challenge-progress"><span id="shakeProgress"></span></div><p class="puzzle-hint" id="shakeHint">Warte auf Bewegungssignal …</p><div class="shake-buttons"><button class="button button-secondary shake-button" type="button" id="simulateShakeBtn">+1 Shake (Demo)</button><button class="button button-secondary shake-button" type="button" id="permissionShakeBtn">Sensor aktivieren</button></div>`, actions:[{label:'Abbrechen',variant:'button-secondary'}] });
  $('simulateShakeBtn').addEventListener('click', () => incrementShake());
  $('permissionShakeBtn').addEventListener('click', async () => {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const permission = await DeviceMotionEvent.requestPermission();
        if (permission !== 'granted') { toast('Sensorzugriff nicht erlaubt', 'Nutze den Demo-Button oder erlaube Bewegungssensoren.', 'warn'); return; }
      }
      if (!('DeviceMotionEvent' in window)) { toast('Sensor nicht verfügbar', 'Auf diesem Gerät gibt es keinen Bewegungssensor.', 'warn'); return; }
      state.shakeHandler = (event) => {
        const acc = event.accelerationIncludingGravity || event.acceleration;
        if (!acc) return;
        const magnitude = Math.sqrt((acc.x||0)**2 + (acc.y||0)**2 + (acc.z||0)**2);
        if (magnitude > 17) incrementShake();
      };
      window.addEventListener('devicemotion', state.shakeHandler);
      $('shakeHint').textContent = 'Bewegungssensor aktiv. Jetzt schütteln!';
    } catch (error) { toast('Sensor konnte nicht aktiviert werden', error?.message || 'Nutze den Demo-Button.', 'warn'); }
  });
  state.shakeTimer = window.setTimeout(() => {
    if (!state.challengeDone) { state.challengeDone = true; stopShakeChallenge(); toast('Challenge abgelaufen', 'Versuche es beim nächsten Mal erneut.', 'warn'); closeModal(); }
  }, 10_000);
}

function incrementShake() {
  if (state.challengeDone || $('modalRoot').classList.contains('hidden')) return;
  state.shakeCount++;
  $('shakeCounter').textContent = String(state.shakeCount);
  $('shakeProgress').style.width = `${Math.min(100,state.shakeCount/state.shakeTarget*100)}%`;
  haptic(10); Sound.click();
  if (state.shakeCount >= state.shakeTarget) {
    state.challengeDone = true;
    stopShakeChallenge();
    closeModal();
    completeTask(state.roomCode,state.uid,'shake').then((ok) => {
      if (ok) { Sound.success(); toast('Shake Challenge geschafft', '+15 Credits gutgeschrieben.', 'success'); }
      else toast('Challenge nicht verfügbar', 'Die Runde hat sich geändert.', 'warn');
    });
  }
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
  if (['countdown','reveal','hide','playing'].includes(room.phase) && room.phaseEndsAt && now() >= room.phaseEndsAt) {
    advanceExpiredPhase(state.roomCode, room).catch((error) => console.warn('phase advance failed', error));
  }
  if (room.phase === 'playing') {
    const self = getSelf();
    if (self?.role === 'seeker' && self.active && now() - state.passiveRewardAt > 25_000) {
      state.passiveRewardAt = now();
      maybePayTimeReward(state.roomCode,state.uid).catch(() => {});
    }
    // Remove expired decoys/traps on a shared transaction. Stale entries never persist indefinitely.
    if (now() - (state.lastCleanupAt || 0) > 15_000) {
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
      updateMap(state.room, state.uid, state.ownLocation || getSelf()?.location, currentRole());
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
    $('freezeTimer').textContent = formatTime(second);
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
