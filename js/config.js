// Firebase Web-App-Konfiguration
export const firebaseConfig = {
  apiKey: "AIzaSyDqOWLwGhLm12lIIs_ERW8YnLP4E02uG5Q",
  authDomain: "real-life-hide-and-seek.firebaseapp.com",
  databaseURL: "https://real-life-hide-and-seek-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "real-life-hide-and-seek",
  storageBucket: "real-life-hide-and-seek.firebasestorage.app",
  messagingSenderId: "73725601381",
  appId: "1:73725601381:web:7320aa53abafaf6637088c",
  measurementId: "G-XY4NZ1BW7M"
};

export const FIREBASE_ENABLED = !Object.values(firebaseConfig).some((value) =>
  typeof value !== "string" || value.trim() === "" || value.includes("YOUR_")
);

export const MAX_PLAYERS = 20;
export const MIN_PLAYERS = 2;
export const ROOM_PATH = "hideSeekRooms";

// Trusted Cloudflare Worker origin. The Worker verifies Firebase ID tokens
// before exposing room or player data; do not replace it with a client key.
export const WORKER_URL = 'https://real-life-hide-and-seek-api.knekkonn-hide-and-seek.workers.dev';
