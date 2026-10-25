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
    let stopped = false, timer = null, lastValue = null;
    const poll = async () => {
      try {
        const room = await getRoom(code);
        if (stopped) return;
        const value = JSON.stringify(room);
        if (value !== lastValue) { lastValue = value; onValue(room); }
      } catch (error) { if (!stopped) onError(error); }
      finally { if (!stopped) timer = setTimeout(poll, 2500); }
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
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
    const messages={TASK_LOCATION_REQUIRED:'Erreiche das markierte Ziel mit genauer GPS-Messung; dieser Versuch ist fehlgeschlagen.',TASK_NOT_HELD:'Du hast den Ort verlassen oder warst zu lange offline; dieser Versuch ist fehlgeschlagen.',TASK_EXPIRED:'Zeit abgelaufen; dieser Versuch ist fehlgeschlagen.',TASK_TOO_FAST:'Die Chiffre wurde zu schnell eingereicht; der Versuch ist fehlgeschlagen.',WRONG_ANSWER:'Falsche Antwort; dieser Versuch ist fehlgeschlagen.',INVALID_PHOTO:'Das Bild muss ein kleines JPEG ohne EXIF-Daten sein; der Versuch ist fehlgeschlagen.',PHOTO_ALREADY_SUBMITTED:'Für diese Runde wurde bereits ein Foto eingereicht.',INVALID_CHALLENGE:'Challenge fehlgeschlagen oder abgelaufen.',NOT_MEMBER:'Du bist noch kein bestätigtes Raum-Mitglied.',HOST_ONLY:'Nur der Host darf diese Aktion ausführen.',LOBBY_CLOSED:'Der Raum ist geschlossen oder läuft bereits.',ROOM_EXPIRED:'Der Raum ist abgelaufen.',STALE_CATCH:'Diese Fanganfrage ist nicht mehr gültig.',RATE_LIMIT:'Zu viele Aktionen. Bitte kurz warten.',CENTER_REQUIRED:'Bitte zuerst einen Zonenmittelpunkt wählen.',FRESH_GPS_REQUIRED:'Eine aktuelle, genaue GPS-Messung wird benötigt.',TASK_COOLDOWN:'Bitte vor einer neuen Aufgabe kurz warten.',FROZEN:'Spielaktionen sind während der Sperrzeit nicht verfügbar.',CODE_IN_USE:'Dieser Raumcode ist bereits vergeben.',UNAUTHENTICATED:'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.'};
    throw new Error(messages[data.error] || data.error || `Backend: ${response.status}`);
  }
  if (data.serverTime) setServerTimeOffset(data.serverTime - (started + Date.now()) / 2);
  return data;
}
export async function workerCommand(code, action, payload={}) {
  const data=await workerRequest(`/rooms/${code}`, {action,...payload});
  if(data.result?.error) { const codes={TASK_TOO_FAST:'Zu schnell gelöst; der Versuch ist fehlgeschlagen.',WRONG_ANSWER:'Falsche Antwort; der Versuch ist fehlgeschlagen.',TASK_LOCATION_REQUIRED:'GPS-Ziel nicht erreicht; der Versuch ist fehlgeschlagen.',TASK_NOT_HELD:'Position nicht gehalten; der Versuch ist fehlgeschlagen.',TASK_EXPIRED:'Zeit abgelaufen; der Versuch ist fehlgeschlagen.',INVALID_PHOTO:'Das Foto ist zu groß oder enthält unzulässige Metadaten; der Versuch ist fehlgeschlagen.'}; const err=new Error(codes[data.result.error] || data.result.error); err.code=data.result.error; throw err; }
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
function callAction(action, args) {
  const [code, , third, fourth] = args;
  if (typeof code !== 'string') return null;
  const fields = {
    advanceExpiredPhase:{}, maybePayTimeReward:{}, updatePlayerLocation:{location:third},
    requestCatch:{targetId:third}, respondToCatch:{accepted:third, requestId:fourth},
    buySkill:{skillId:third}, activateSkill:{skillId:third,params:fourth},
    collectItemBox:{boxId:third}, completeTask:{kind:third,proof:fourth}, leaveRoom:{}
  };
  return workerCommand(code,action,fields[action]).then((data)=>data.result);
}
