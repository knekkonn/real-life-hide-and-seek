import { firebaseConfig } from '../js/config.js';
const verified = new Map();
export async function authenticate(request, fetcher=fetch) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') || '');
  if (!match || match[1].length > 8192) throw new Error('UNAUTHENTICATED');
  const token = match[1];
  const cached = verified.get(token);
  if (cached && cached.until > Date.now()) return cached.uid;
  const response = await fetcher(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseConfig.apiKey)}`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({idToken:token}), signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('UNAUTHENTICATED');
  const data = await response.json();
  const uid = data.users?.[0]?.localId;
  if (!uid || data.users[0].disabled) throw new Error('UNAUTHENTICATED');
  // Cache only after Google verified the token for this Firebase project.
  let expiry = 0;
  try { expiry = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).exp * 1000; } catch {}
  if (verified.size > 1000) verified.clear();
  if (expiry > Date.now()) verified.set(token,{uid,until:Math.min(expiry,Date.now()+60000)});
  return uid;
}
