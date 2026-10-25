// Run only under Firebase Emulator Suite. No production host is used.
import test from 'node:test';
import assert from 'node:assert/strict';
test('Realtime Database rejects anonymous and authenticated room reads/writes',async()=>{
  assert.ok(process.env.FIREBASE_DATABASE_EMULATOR_HOST,'Start with firebase emulators:exec');
  const authHost=process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
  const signup=await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({returnSecureToken:true})});
  const {idToken}=await signup.json(); assert.ok(idToken);
  for (const token of [null,idToken]) for (const method of ['GET','PUT']) {
    const url=new URL(`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/hideSeekRooms/1234.json`);
    url.searchParams.set('ns','demo-hide-seek-default-rtdb');
    if(token) url.searchParams.set('auth',token);
    const response=await fetch(url,{method,...(method==='PUT'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({hostId:'forged'})}:{})});
    assert.equal(response.status,401);
    assert.match((await response.json()).error,/Permission denied/i);
  }
});
