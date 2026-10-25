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
      const path=new URL(request.url).pathname;
      const photoMatch=/^\/rooms\/(\d{4})\/photos\/([A-Za-z0-9_-]{4,128})$/.exec(path);
      const match=/^\/rooms\/(\d{4})$/.exec(path);
      if (!match && !photoMatch) return reply({error:'NOT_FOUND'},404);
      if (photoMatch && request.method!=='GET') return reply({error:'METHOD_NOT_ALLOWED'},405);
      const uid=await authenticate(request);
      const code=(photoMatch || match)[1];
      if(photoMatch) {
        await limit(env,uid,'photo-read',60,60000);
        for(let attempt=0;attempt<5;attempt++) {
          const row=await env.DB.prepare('SELECT state,revision,expires_at FROM rooms WHERE code=?').bind(code).first();
          if(!row || row.expires_at<Date.now()) return reply({error:'ROOM_EXPIRED'},404);
          let room=JSON.parse(row.state);
          if(room.phase==='playing' && room.phaseEndsAt && room.phaseEndsAt<=Date.now()) {
            room=await settlePhases(room);
            const saved=await env.DB.prepare('UPDATE rooms SET state=?,revision=revision+1 WHERE code=? AND revision=?').bind(JSON.stringify(room),code,row.revision).run();
            if(!saved.meta.changes) continue;
          }
          const viewer=room.players?.[uid], photo=room.photoMetadata?.[photoMatch[2]];
          if(!viewer || !viewer.active || viewer.status==='left' || viewer.role!=='seeker' || room.phase!=='playing' || !photo || photo.roundId!==(room.roundId || room.startedAt || room.createdAt)) return reply({error:'PHOTO_NOT_AVAILABLE'},403);
          const bytes=Uint8Array.from(atob(photo.image.split(',')[1]),char=>char.charCodeAt(0));
          return new Response(bytes,{status:200,headers:{...headers,'Content-Type':'image/jpeg','Content-Disposition':'inline; filename="round-photo.jpg"'}});
        }
        return reply({error:'CONCURRENT_UPDATE_RETRY'},409);
      }
      let input;
      if (request.method==='POST') {
        if (Number(request.headers.get('Content-Length'))>65536) return reply({error:'PAYLOAD_TOO_LARGE'},413);
        const text=await request.text();
        const bodySize=new TextEncoder().encode(text).length;
        if (bodySize>65536) return reply({error:'PAYLOAD_TOO_LARGE'},413);
        try { input=JSON.parse(text); } catch { return reply({error:'INVALID_JSON'},400); }
        if (!input || typeof input!=='object' || Array.isArray(input)) return reply({error:'INVALID_JSON'},400);
        if (input.action!=='submitPhoto' && bodySize>16384) return reply({error:'PAYLOAD_TOO_LARGE'},413);
        await limit(env,uid,'action',90,60000);
        if (input.action==='join') await limit(env,uid,'join',5,60000);
        if (input.action==='submitPhoto') await limit(env,uid,'photo',3,300000);
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
        for (const key of ['traps','decoys']) for (const [id,item] of Object.entries(next[key] || {})) if (item.expiresAt<Date.now()) delete next[key][id];
        const serialized=JSON.stringify(next);
        if (serialized.length>1024000) return reply({error:'ROOM_LIMIT'},409);
        const saved=await env.DB.prepare('UPDATE rooms SET state=?,revision=revision+1 WHERE code=? AND revision=?').bind(serialized,code,row.revision).run();
        if (saved.meta.changes) return reply({result});
      }
      return reply({error:'CONCURRENT_UPDATE_RETRY'},409);
    } catch (error) {
      const message=error?.message || 'BACKEND_ERROR';
      const known=/^(UNAUTHENTICATED|NOT_MEMBER|HOST_ONLY|LOBBY_CLOSED|ROOM_FULL|NAME_IN_USE|INVALID_NAME|CENTER_REQUIRED|INVALID_GPS|STALE_CATCH|CATCH_RANGE_REQUIRED|TARGET_NOT_CATCHABLE|FRESH_GPS_REQUIRED|INVALID_POINT|TASK_UNAVAILABLE|TASK_COOLDOWN|TASK_ALREADY_ACTIVE|TASK_EXPIRED|NO_OBJECTIVES|INVALID_PHOTO|PHOTO_ALREADY_SUBMITTED|INVALID_CHALLENGE|WRONG_ANSWER|TASK_TOO_FAST|UNKNOWN_ACTION|RATE_LIMIT|FROZEN)$/.test(message);
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
