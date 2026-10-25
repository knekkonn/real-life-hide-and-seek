import { authenticate } from './auth.js';
import { applyAction, publicRoom, settlePhases } from './game.js';
import { createRoomData } from '../js/game-service.js';

async function limit(env,uid,kind,max,windowMs) {
  const bucket=Math.floor(Date.now()/windowMs);
  const key=`${kind}:${uid}:${bucket}`;
  const row=await env.DB.prepare('INSERT INTO rate_limits(key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits').bind(key,(bucket+2)*windowMs).first();
  if (row.hits>max) throw new Error('RATE_LIMIT');
}

export default {
  async fetch(request,env) {
    const origin=request.headers.get('Origin');
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
    if (origin && origin !== env.ALLOWED_ORIGIN) return new Response(JSON.stringify({error:'ORIGIN_DENIED'}),{status:403,headers});
    if (origin) headers['Access-Control-Allow-Origin']=origin;
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'}});
    const reply=(body,status=200)=>new Response(JSON.stringify({...body,serverTime:Date.now()}),{status,headers});
    try {
      if (!['GET','POST'].includes(request.method)) return reply({error:'METHOD_NOT_ALLOWED'},405);
      const match=/^\/rooms\/(\d{4})$/.exec(new URL(request.url).pathname);
      if (!match) return reply({error:'NOT_FOUND'},404);
      const uid=await authenticate(request);
      const code=match[1];
      let input;
      if (request.method==='POST') {
        if (Number(request.headers.get('Content-Length'))>16384) return reply({error:'PAYLOAD_TOO_LARGE'},413);
        const text=await request.text();
        if (new TextEncoder().encode(text).length>16384) return reply({error:'PAYLOAD_TOO_LARGE'},413);
        try { input=JSON.parse(text); } catch { return reply({error:'INVALID_JSON'},400); }
        if (!input || typeof input!=='object' || Array.isArray(input)) return reply({error:'INVALID_JSON'},400);
        await limit(env,uid,'action',90,60000);
        if (input.action==='join') await limit(env,uid,'join',5,60000);
        if (input.action==='create') {
          await limit(env,uid,'create',3,3600000);
          if (typeof input.name!=='string' || !/^[\p{L}\p{N}_ -]{2,18}$/u.test(input.name)) return reply({error:'INVALID_NAME'},400);
          const room=createRoomData(uid,input.name); room.code=code;
          // An expired row is removed before allocation; active codes cannot be overwritten.
          await env.DB.prepare('DELETE FROM rooms WHERE code=? AND expires_at<?').bind(code,Date.now()).run();
          const result=await env.DB.prepare('INSERT OR IGNORE INTO rooms(code,revision,state,expires_at) VALUES (?,0,?,?)').bind(code,JSON.stringify(room),Date.now()+86400000).run();
          if (!result.meta.changes) return reply({error:'CODE_IN_USE'},409);
          return reply({room:publicRoom(room,uid),result:true});
        }
      }
      for (let attempt=0;attempt<8;attempt++) {
        const row=await env.DB.prepare('SELECT state,revision,expires_at FROM rooms WHERE code=?').bind(code).first();
        if (!row || row.expires_at<Date.now()) return request.method==='GET' ? reply({room:null}) : reply({error:'ROOM_EXPIRED'},404);
        let room=JSON.parse(row.state);
        if (request.method==='GET') {
          publicRoom(room,uid); // Authorize before doing any maintenance.
          const prior=JSON.stringify(room);
          room=await settlePhases(room);
          if (JSON.stringify(room)!==prior) {
            const saved=await env.DB.prepare('UPDATE rooms SET state=?,revision=revision+1 WHERE code=? AND revision=?').bind(JSON.stringify(room),code,row.revision).run();
            if (!saved.meta.changes) continue;
          }
          return reply({room:publicRoom(room,uid)});
        }
        const {room:next,result}=await applyAction(room,uid,input);
        if (!next) return reply({error:'ACTION_REJECTED'},409);
        for (const [id,req] of Object.entries(next.joinRequests || {})) if (Date.now()-req.createdAt>300000) delete next.joinRequests[id];
        for (const key of ['traps','decoys']) for (const [id,item] of Object.entries(next[key] || {})) if (item.expiresAt<Date.now()) delete next[key][id];
        const serialized=JSON.stringify(next);
        if (serialized.length>128000) return reply({error:'ROOM_LIMIT'},409);
        const saved=await env.DB.prepare('UPDATE rooms SET state=?,revision=revision+1 WHERE code=? AND revision=?').bind(serialized,code,row.revision).run();
        if (saved.meta.changes) return reply({result});
      }
      return reply({error:'CONCURRENT_UPDATE_RETRY'},409);
    } catch (error) {
      const message=error?.message || 'BACKEND_ERROR';
      const known=/^(UNAUTHENTICATED|NOT_MEMBER|HOST_ONLY|LOBBY_CLOSED|REQUESTS_FULL|INVALID_NAME|REQUEST_EXPIRED|CENTER_REQUIRED|INVALID_GPS|STALE_CATCH|FRESH_GPS_REQUIRED|INVALID_POINT|TASK_UNAVAILABLE|TASK_COOLDOWN|INVALID_CHALLENGE|WRONG_ANSWER|CHALLENGE_TOO_FAST|UNKNOWN_ACTION|RATE_LIMIT|FROZEN)$/.test(message);
      const status=message==='UNAUTHENTICATED'?401:message==='RATE_LIMIT'?429:message==='NOT_MEMBER'||message==='HOST_ONLY'?403:known?409:500;
      return reply({error:known?message:'BACKEND_ERROR'},status);
    }
  },
  async scheduled(event,env,context) {
    context.waitUntil(env.DB.batch([
      env.DB.prepare('DELETE FROM rooms WHERE expires_at<?').bind(Date.now()),
      env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now())
    ]));
  }
};
