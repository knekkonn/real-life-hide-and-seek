import { configureStore } from './store.js';
import { normalizeRoom, transactRoom } from './transactions.js';
import { firebaseConfig, FIREBASE_ENABLED, ROOM_PATH, WORKER_URL } from './config.js';
import { setServerTimeOffset } from './utils.js';

let backendMode = 'unavailable';
let db = null;
let auth = null;
let firebaseApi = null;
let playerUid = null;
let initialization = null;
export function initBackend() {
  if (initialization) return initialization;
  initialization = initializeBackend().catch((error) => {
    backendMode = 'unavailable';
    playerUid = null;
    initialization = null;
    throw new Error(`Firebase-Verbindung fehlgeschlagen: ${error?.message || 'Unbekannter Fehler'}`);
  });
  return initialization;
}

async function initializeBackend() {
  if (!FIREBASE_ENABLED) {
    throw new Error('Firebase ist nicht konfiguriert. Geräteübergreifendes Spielen benötigt Firebase.');
  }
  const [appMod, authMod, dbMod] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js')
  ]);
  firebaseApi = { ...appMod, ...authMod, ...dbMod };
  const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(firebaseConfig);
  auth = authMod.getAuth(app);
  await authMod.setPersistence(auth, authMod.browserLocalPersistence);
  await auth.authStateReady();
  const user = auth.currentUser || (await authMod.signInAnonymously(auth)).user;
  db = dbMod.getDatabase(app);
  if (!WORKER_URL) dbMod.onValue(dbMod.ref(db, '.info/serverTimeOffset'), (snapshot) => {
    setServerTimeOffset(Number(snapshot.val()) || 0);
  });
  playerUid = user.uid;
  backendMode = WORKER_URL ? 'worker' : 'firebase';
  configureStore({mutate:mutateRoom, action:WORKER_URL ? callAction : null});
  return { mode:backendMode, uid:playerUid };
}

function requireBackend() {
  if (!['firebase','worker'].includes(backendMode) || !playerUid) throw new Error('Firebase ist nicht verbunden. Bitte erneut verbinden.');
}

export function getBackendMode() { return backendMode; }
export function getPlayerUid() { return playerUid; }
export function getAccountInfo() {
  const user=auth?.currentUser;
  return user?{uid:user.uid,email:user.email||null,isAnonymous:user.isAnonymous===true}:null;
}
export async function registerAccount(email,password) {
  requireBackend();
  const user=auth?.currentUser;
  if(!user) throw new Error('Bitte zuerst mit dem Backend verbinden.');
  if(!user.isAnonymous) throw new Error('Dieses Gerät ist bereits mit einem Konto angemeldet.');
  const credential=firebaseApi.EmailAuthProvider.credential(email.trim(),password);
  const result=await firebaseApi.linkWithCredential(user,credential);
  playerUid=result.user.uid;
  return getAccountInfo();
}
export async function signInAccount(email,password) {
  if(!auth || !firebaseApi) await initBackend();
  const result=await firebaseApi.signInWithEmailAndPassword(auth,email.trim(),password);
  playerUid=result.user.uid;
  configureStore({mutate:mutateRoom,action:WORKER_URL?callAction:null});
  return getAccountInfo();
}
export async function signOutAccount() {
  if(!auth || !firebaseApi) return;
  await firebaseApi.signOut(auth);
  const result=await firebaseApi.signInAnonymously(auth);
  playerUid=result.user.uid;
  return getAccountInfo();
}
export async function sendAccountPasswordReset(email) {
  if(!auth || !firebaseApi) await initBackend();
  await firebaseApi.sendPasswordResetEmail(auth,email.trim());
}

function roomRef(code) {
  return firebaseApi.ref(db, `${ROOM_PATH}/${code}`);
}

export async function getRoom(code) {
  requireBackend();
  if (WORKER_URL) return (await workerRequest(`/rooms/${code}`)).room;
  if (backendMode === 'firebase') {
    const snapshot = await firebaseApi.get(roomRef(code));
    return snapshot.exists() ? normalizeRoom(snapshot.val()) : null;
  }
  throw new Error('Firebase ist nicht verbunden.');
}

export async function createRoom(code, initialRoom) {
  requireBackend();
  if (WORKER_URL) { await workerRequest(`/rooms/${code}`, {action:'create', name:initialRoom.players[playerUid].name}); return true; }
  if (backendMode === 'firebase') {
    const result = await firebaseApi.runTransaction(roomRef(code), (current) => current == null ? initialRoom : undefined, { applyLocally: false });
    return result.committed;
  }
  throw new Error('Firebase ist nicht verbunden.');
}

export async function mutateRoom(code, mutator) {
  requireBackend();
  if (WORKER_URL) throw new Error('Direkte Raumänderungen sind im sicheren Backend gesperrt.');
  if (backendMode === 'firebase') {
    return transactRoom(firebaseApi, roomRef(code), mutator);
  }
  throw new Error('Firebase ist nicht verbunden.');
}

export function subscribeRoom(code, onValue, onError = () => {}) {
  requireBackend();
  if (WORKER_URL) {
    let stopped = false, timer = null, revision = null, lastValue = null, inFlight = false;
    const schedule=()=>{ if(!stopped) timer=setTimeout(poll,document.visibilityState==='hidden'?30000:5000); };
    const poll = async () => {
      if(stopped||inFlight) return;
      inFlight=true;
      try {
        const suffix=Number.isSafeInteger(revision)?`?since=${revision}`:'';
        const data=await workerRequest(`/rooms/${code}${suffix}`);
        if (stopped) return;
        if(Number.isSafeInteger(data.revision)) revision=data.revision;
        if(!data.unchanged) {
          const value=JSON.stringify(data.room??null);
          if(value!==lastValue) { lastValue=value; onValue(data.room??null); }
        }
      } catch (error) { if (!stopped) onError(error); }
      // Keep live play responsive while staying well inside Cloudflare's free
      // request allowance; unchanged revisions carry only a tiny response body.
      finally { inFlight=false; schedule(); }
    };
    const onVisibility=()=>{ if(document.visibilityState==='visible') { clearTimeout(timer); poll(); } };
    document.addEventListener('visibilitychange',onVisibility);
    poll();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange',onVisibility); };
  }
  if (backendMode === 'firebase') {
    return firebaseApi.onValue(roomRef(code), (snapshot) => onValue(snapshot.exists() ? normalizeRoom(snapshot.val()) : null), onError);
  }
  throw new Error('Firebase ist nicht verbunden.');
}

export async function deleteRoom(code) {
  requireBackend();
  if (backendMode === 'firebase') {
    await firebaseApi.remove(roomRef(code));
    return;
  }
  throw new Error('Firebase ist nicht verbunden.');
}

export function subscribeConnection(onStatus) {
  if (WORKER_URL && playerUid) {
    connectionListener = onStatus;
    onStatus(navigator.onLine);
    return () => { if (connectionListener === onStatus) connectionListener = null; };
  }
  if (backendMode !== 'firebase') {
    onStatus(false);
    return () => {};
  }
  const infoRef = firebaseApi.ref(db, '.info/connected');
  return firebaseApi.onValue(infoRef, (snapshot) => onStatus(snapshot.val() === true));
}

let connectionListener = null;
async function workerRequest(path, body) {
  const token = await auth.currentUser.getIdToken();
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${WORKER_URL.replace(/\/$/,'')}${path}`, {
      method:body ? 'POST' : 'GET', cache:'no-store',
      headers:{Authorization:`Bearer ${token}`, ...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(15000)
    });
  } catch (error) { connectionListener?.(false); throw error; }
  const data = await response.json();
  connectionListener?.(true);
  if (!response.ok) {
    const messages={NO_OBJECTIVES:'Für diese Aufgabe ist gerade kein Ziel verfügbar.',TASK_UNAVAILABLE:'Diese Aufgabe ist in deiner Rolle oder Spielphase nicht verfügbar.',TASK_HIDER_NOT_NEARBY:'Kein aktiver Hider im 10-m-Suchradius.',TASK_LOCATION_REQUIRED:'Erreiche das markierte Ziel innerhalb von 10 m mit einer genauen GPS-Messung; dieser Versuch ist fehlgeschlagen.',TASK_NOT_HELD:'Du hast den Ort verlassen oder warst zu lange offline; dieser Versuch ist fehlgeschlagen.',TASK_EXPIRED:'Zeit abgelaufen; dieser Versuch ist fehlgeschlagen.',TASK_TOO_FAST:'Die Chiffre wurde zu schnell eingereicht; der Versuch ist fehlgeschlagen.',WRONG_ANSWER:'Falsche Antwort; dieser Versuch ist fehlgeschlagen.',INVALID_PHOTO:'Das Bild muss ein kleines JPEG ohne EXIF-Daten sein; der Versuch ist fehlgeschlagen.',PHOTO_ALREADY_SUBMITTED:'Für diese Runde wurde bereits ein Foto eingereicht.',INVALID_CHALLENGE:'Challenge fehlgeschlagen oder abgelaufen.',NOT_MEMBER:'Du bist noch kein bestätigtes Raum-Mitglied.',HOST_ONLY:'Nur der Host darf diese Aktion ausführen.',NOT_ENOUGH_PLAYERS:'Für eine neue Runde müssen mindestens zwei Spieler im Raum sein.',NOT_ENOUGH_HIDERS:'Mit den aktuellen Einstellungen muss mindestens ein Hider übrig bleiben. Passe die Seeker-Anzahl an.',ROUND_RESTART_FAILED:'Der Neustart konnte nicht vorbereitet werden. Öffne die Lobby und prüfe die Einstellungen.',LOBBY_CLOSED:'Der Raum ist geschlossen oder läuft bereits.',ROOM_FULL:'Der Raum ist voll (max. 20 Spieler).',NAME_IN_USE:'Dieser Codename wird im Raum bereits verwendet.',ROOM_EXPIRED:'Der Raumcode existiert nicht mehr. Bitte prüfe den Code oder erstelle eine neue Lobby.',STALE_CATCH:'Diese Fangaktion ist nicht mehr gültig.',CATCH_RANGE_REQUIRED:'Du musst dich innerhalb von 8 m befinden, um einen Fang auszulösen.',TARGET_NOT_CATCHABLE:'Dieser Hider ist nicht mehr fangbar.',RATE_LIMIT:'Zu viele Aktionen. Bitte kurz warten.',CENTER_REQUIRED:'Bitte zuerst einen Zonenmittelpunkt wählen.',FRESH_GPS_REQUIRED:'Für diese Aktion wird eine aktuelle GPS-Messung benötigt.',TASK_COOLDOWN:'Bitte vor einer neuen Aufgabe kurz warten.',FROZEN:'Spielaktionen sind während der Sperrzeit nicht verfügbar.',RELOCATION_REQUIRED:'Du musst erst den geforderten Abstand zu deinem vorherigen Standort erreichen.',RESTRICTED_AREA:'Dieser Kartenabschnitt ist vorübergehend gesperrt. Wähle einen sicheren Weg außen herum.',POINTS_REQUIRED:'Dafür hast du nicht genug Punkte.',ABILITY_COOLDOWN:'Diese Fähigkeit hat noch Cooldown.',ABILITY_UNAVAILABLE:'Diese Fähigkeit ist in dieser Rolle oder Spielphase nicht verfügbar.',SEEKER_NOT_NEARBY:'Kein Seeker ist mit frischer GPS-Messung in Reichweite.',SKILL_UNAVAILABLE:'Diese Fähigkeit ist nicht in deinem Inventar.',INVALID_ZONE_SETTINGS:'Radius oder Sperrdauer liegen außerhalb der erlaubten Werte.',NO_ACTIVE_HIDERS:'Es gibt keine aktiven Hider mehr.',RELOCATION_PENDING:'Mindestens ein ausgewählter Hider hat noch eine offene Umpositionierung.',ZONE_LIMIT:'Es sind bereits drei Sperrzonen aktiv.',EXCHANGE_LIMIT:'Du hast deine drei Zeit-Tausche für diese Runde genutzt.',MINIMUM_GAME_TIME:'Der Tausch muss mindestens fünf Minuten Restspielzeit übrig lassen.',INVALID_ABILITY:'Diese Fähigkeit ist ungültig.',CODE_IN_USE:'Dieser Raumcode ist bereits vergeben.',UNAUTHENTICATED:'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.',ACCOUNT_REQUIRED:'Für gespeicherte Profile und den Testmodus brauchst du ein registriertes Konto.',TEST_MODE_DENIED:'Der Test-Zugangscode stimmt nicht.',TEST_MODE_DISABLED:'Der geschützte Testmodus ist derzeit nicht freigeschaltet.',PROFILE_INVALID:'Profilname oder Avatar-Optik ist ungültig.'};
    const error=new Error(messages[data.error] || data.error || `Backend: ${response.status}`);
    error.code=data.error;
    throw error;
  }
  if (data.serverTime) setServerTimeOffset(data.serverTime - (started + Date.now()) / 2);
  return data;
}
export async function workerCommand(code, action, payload={}) {
  const data=await workerRequest(`/rooms/${code}`, {action,...payload});
  if(data.result?.error) {
    const result=data.result;
    const codes={TASK_HIDER_NOT_NEARBY:'Kein aktiver Hider im 35-m-Suchradius; der Versuch ist fehlgeschlagen.',TASK_TOO_FAST:'Zu schnell gelöst; der Versuch ist fehlgeschlagen.',TASK_LOCATION_REQUIRED:'GPS-Ziel nicht erreicht; der Versuch ist fehlgeschlagen.',TASK_NOT_HELD:'Position nicht gehalten; der Versuch ist fehlgeschlagen.',TASK_EXPIRED:'Zeit abgelaufen; der Versuch ist fehlgeschlagen.',INVALID_PHOTO:'Das Foto ist zu groß oder enthält unzulässige Metadaten; der Versuch ist fehlgeschlagen.'};
    let message=codes[result.error] || result.error;
    if(result.error==='WRONG_ANSWER') message=result.attemptsRemaining>0?`Falscher Code. Noch ${result.attemptsRemaining} ${result.attemptsRemaining===1?'Versuch':'Versuche'}.`:'Falscher Code. Alle drei Versuche sind aufgebraucht; der Cooldown läuft.';
    const err=new Error(message); err.code=result.error;
    if(Number.isInteger(result.attemptsRemaining)) err.attemptsRemaining=result.attemptsRemaining;
    throw err;
  }
  return data;
}
export async function fetchRoundPhoto(code, playerId) {
  requireBackend();
  if(!WORKER_URL || backendMode!=='worker') throw new Error('Rundenfotos benötigen das Worker-Backend.');
  const token=await auth.currentUser.getIdToken();
  let response;
  try { response=await fetch(`${WORKER_URL.replace(/\/$/,'')}/rooms/${code}/photos/${encodeURIComponent(playerId)}`,{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(15000)}); }
  catch(error) { connectionListener?.(false); throw error; }
  connectionListener?.(true);
  if(!response.ok) {
    const data=await response.json().catch(()=>({}));
    const messages={PHOTO_NOT_AVAILABLE:'Dieses Rundenfoto ist nicht mehr verfügbar.',UNAUTHENTICATED:'Die Anmeldung ist abgelaufen.'};
    throw new Error(messages[data.error] || 'Foto konnte nicht geladen werden.');
  }
  return response.blob();
}
export async function getAccountProfile() {
  requireBackend();
  if(!WORKER_URL) throw new Error('Gespeicherte Profile benötigen das Worker-Backend.');
  const data=await workerRequest('/profile');
  return data.profile;
}
export async function saveAccountProfile(profile) {
  requireBackend();
  if(!WORKER_URL) throw new Error('Gespeicherte Profile benötigen das Worker-Backend.');
  const data=await workerRequest('/profile',profile);
  return data.profile;
}
export async function enableProtectedTestMode(code) {
  requireBackend();
  if(!WORKER_URL) throw new Error('Der geschützte Testmodus benötigt das Worker-Backend.');
  return (await workerRequest('/test-mode',{code})).enabled===true;
}
function callAction(action, args) {
  const [code, , third, fourth] = args;
  if (typeof code !== 'string') return null;
  const fields = {
    advanceExpiredPhase:{}, maybePayTimeReward:{}, updatePlayerLocation:{location:third},
    requestCatch:{targetId:third},
    buySkill:{skillId:third}, activateSkill:{skillId:third,params:fourth},
    collectItemBox:{boxId:third}, completeTask:{kind:third,proof:fourth}, leaveRoom:{}
  };
  return workerCommand(code,action,fields[action]).then((data)=>data.result);
}
