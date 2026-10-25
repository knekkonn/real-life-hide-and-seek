import { firebaseConfig, FIREBASE_ENABLED, ROOM_PATH } from './config.js';
import { setServerTimeOffset } from './utils.js';

let backendMode = 'demo';
let db = null;
let auth = null;
let firebaseApi = null;
let playerUid = null;
let initialized = false;
const demoListeners = new Map();
const DEMO_PREFIX = 'hideseek-room:';

function demoKey(code) { return `${DEMO_PREFIX}${code}`; }
function readDemoRoom(code) {
  try {
    const value = localStorage.getItem(demoKey(code));
    return value ? JSON.parse(value) : null;
  } catch { return null; }
}
function emitDemoRoom(code, room) {
  // The custom event notifies same-tab listeners; the storage event notifies other tabs.
  window.dispatchEvent(new CustomEvent('hideseek-demo-update', { detail: { code } }));
}
function structuredCloneSafe(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

export async function initBackend() {
  if (initialized) return { mode: backendMode, uid: playerUid };
  initialized = true;
  if (FIREBASE_ENABLED) {
    try {
      const [appMod, authMod, dbMod] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js'),
        import('https://www.gstatic.com/firebasejs/13.1.0/firebase-database.js')
      ]);
      firebaseApi = { ...appMod, ...authMod, ...dbMod };
      const app = appMod.initializeApp(firebaseConfig);
      auth = authMod.getAuth(app);
      db = dbMod.getDatabase(app);
      dbMod.onValue(dbMod.ref(db, '.info/serverTimeOffset'), (snapshot) => {
        setServerTimeOffset(Number(snapshot.val()) || 0);
      });
      const credential = await authMod.signInAnonymously(auth);
      playerUid = credential.user.uid;
      backendMode = 'firebase';
      return { mode: backendMode, uid: playerUid };
    } catch (error) {
      console.error('Firebase konnte nicht initialisiert werden; Demo-Modus wird verwendet.', error);
      backendMode = 'demo';
      playerUid = getDemoUid();
      throw new Error(`Firebase-Verbindung fehlgeschlagen: ${error?.message || 'Unbekannter Fehler'}`);
    }
  }
  playerUid = getDemoUid();
  backendMode = 'demo';
  return { mode: backendMode, uid: playerUid };
}

function getDemoUid() {
  const key = 'hideseek-demo-player-id';
  try {
    let uid = sessionStorage.getItem(key);
    if (!uid) {
      uid = `demo_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
      sessionStorage.setItem(key, uid);
    }
    return uid;
  } catch {
    return `demo_${Math.random().toString(36).slice(2, 14)}`;
  }
}

export function getBackendMode() { return backendMode; }
export function getPlayerUid() { return playerUid; }

function roomRef(code) {
  return firebaseApi.ref(db, `${ROOM_PATH}/${code}`);
}

export async function getRoom(code) {
  if (backendMode === 'firebase') {
    const snapshot = await firebaseApi.get(roomRef(code));
    return snapshot.exists() ? snapshot.val() : null;
  }
  return readDemoRoom(code);
}

export async function primeRoomForTransaction(code) {
  if (backendMode !== 'firebase') return readDemoRoom(code);
  const ref = roomRef(code);
  const initial = await firebaseApi.get(ref);
  if (!initial.exists()) return null;

  // A one-shot get() does not reliably populate RTDB's sync tree for an
  // immediate runTransaction() on a fresh client. Wait for the live listener
  // to deliver the room first, so the transaction starts from current data.
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const timer = window.setTimeout(() => finish(new Error('room-cache-timeout')), 10000);
    const finish = (error, room) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve(room);
    };
    unsubscribe = firebaseApi.onValue(ref, (snapshot) => {
      if (snapshot.exists()) finish(null, snapshot.val());
    }, (error) => finish(error));
  });
}

export async function createRoom(code, initialRoom) {
  if (backendMode === 'firebase') {
    const result = await firebaseApi.runTransaction(roomRef(code), (current) => current == null ? initialRoom : undefined, { applyLocally: false });
    return result.committed;
  }
  if (readDemoRoom(code)) return false;
  localStorage.setItem(demoKey(code), JSON.stringify(initialRoom));
  emitDemoRoom(code, initialRoom);
  return true;
}

export async function mutateRoom(code, mutator) {
  if (backendMode === 'firebase') {
    const result = await firebaseApi.runTransaction(roomRef(code), (current) => {
      if (current == null) return undefined;
      return mutator(current) ?? undefined;
    }, { applyLocally: false });
    if (!result.committed) return null;
    return result.snapshot.val();
  }
  const current = readDemoRoom(code);
  if (!current) return null;
  const next = mutator(structuredCloneSafe(current));
  if (next == null) return null;
  localStorage.setItem(demoKey(code), JSON.stringify(next));
  emitDemoRoom(code, next);
  return next;
}

export function subscribeRoom(code, onValue, onError = () => {}) {
  if (backendMode === 'firebase') {
    return firebaseApi.onValue(roomRef(code), (snapshot) => onValue(snapshot.exists() ? snapshot.val() : null), onError);
  }
  if (!demoListeners.has(code)) demoListeners.set(code, new Set());
  const listeners = demoListeners.get(code);
  listeners.add(onValue);
  const storageHandler = (event) => {
    if (event.key === demoKey(code)) onValue(readDemoRoom(code));
  };
  const customHandler = (event) => {
    if (event.detail?.code === code) onValue(readDemoRoom(code));
  };
  window.addEventListener('storage', storageHandler);
  window.addEventListener('hideseek-demo-update', customHandler);
  queueMicrotask(() => onValue(readDemoRoom(code)));
  return () => {
    listeners.delete(onValue);
    window.removeEventListener('storage', storageHandler);
    window.removeEventListener('hideseek-demo-update', customHandler);
  };
}

export async function deleteRoom(code) {
  if (backendMode === 'firebase') {
    await firebaseApi.remove(roomRef(code));
    return;
  }
  localStorage.removeItem(demoKey(code));
  emitDemoRoom(code, null);
}

export function subscribeConnection(onStatus) {
  if (backendMode !== 'firebase') {
    onStatus(true);
    return () => {};
  }
  const infoRef = firebaseApi.ref(db, '.info/connected');
  return firebaseApi.onValue(infoRef, (snapshot) => onStatus(snapshot.val() === true));
}
