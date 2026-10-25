import { authenticate } from './auth.js';
import { applyAction, publicRoom, settlePhases } from './game.js';
import { createRoomData } from '../js/game-service.js';
import { normalizeAccountProfile } from '../js/profile.js';

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
      const profileRoute=path==='/profile',testModeRoute=path==='/test-mode';
      if (!match && !photoMatch && !profileRoute && !testModeRoute) return reply({error:'NOT_FOUND'},404);
      if (photoMatch && request.method!=='GET') return reply({error:'METHOD_NOT_ALLOWED'},405);
      if (profileRoute && !['GET','POST'].includes(request.method)) return reply({error:'METHOD_NOT_ALLOWED'},405);
      if (testModeRoute && request.method!=='POST') return reply({error:'METHOD_NOT_ALLOWED'},405);
      const uid=await authenticate(request,fetch,{accountOnly:profileRoute||testModeRoute});
      if(profileRoute) {
        await limit(env,uid,'profile',30,60000);
        if(request.method==='GET') return reply({profile:await readProfile(env,uid)});
        const input=await readJson(request,8192);
        const existing=await env.DB.prepare('SELECT display_name,cosmetic_id,sound_enabled,haptics_enabled FROM account_profiles WHERE uid=?').bind(uid).first();
        const profile=normalizeAccountProfile(input,existing?{displayName:existing.display_name,cosmeticId:existing.cosmetic_id,soundEnabled:existing.sound_enabled===1,hapticsEnabled:existing.haptics_enabled===1}:{displayName:'',cosmeticId:'lime'});
        await env.DB.prepare('INSERT INTO account_profiles(uid,display_name,cosmetic_id,sound_enabled,haptics_enabled,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET display_name=excluded.display_name,cosmetic_id=excluded.cosmetic_id,sound_enabled=excluded.sound_enabled,haptics_enabled=excluded.haptics_enabled,updated_at=excluded.updated_at').bind(uid,profile.displayName,profile.cosmeticId,profile.soundEnabled?1:0,profile.hapticsEnabled?1:0,Date.now()).run();
        return reply({profile});
      }
      if(testModeRoute) {
        await limit(env,uid,'test-mode',5,300000);
        if(!env.TEST_MODE_CODE) return reply({error:'TEST_MODE_DISABLED'},404);
        const input=await readJson(request,2048);
        if(!constantTimeEqual(String(input.code||''),env.TEST_MODE_CODE)) throw new Error('TEST_MODE_DENIED');
        return reply({enabled:true,expiresAt:Date.now()+30*60*1000});
      }
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
          const savedProfile=await readProfile(env,uid);
          if(room.players?.[uid]) room.players[uid].cosmeticId=savedProfile.cosmeticId;
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
          const changed=JSON.stringify(room)!==prior;
          if (changed) {
            const saved=await env.DB.prepare('UPDATE rooms SET state=?,revision=revision+1 WHERE code=? AND revision=?').bind(JSON.stringify(room),code,row.revision).run();
            if (!saved.meta.changes) continue;
          }
          const revision=Number(row.revision)+(changed?1:0);
          const sinceText=new URL(request.url).searchParams.get('since');
          const since=sinceText===null?null:Number(sinceText);
          if(Number.isSafeInteger(since)&&since===revision) return reply({unchanged:true,revision});
          return reply({room:publicRoom(room,uid),revision});
        }
        const {room:next,result}=await applyAction(room,uid,input);
        if (!next) return reply({error:'ACTION_REJECTED'},409);
        if(input.action==='join'&&next.players?.[uid]) next.players[uid].cosmeticId=(await readProfile(env,uid)).cosmeticId;
        for (const key of ['traps','decoys']) for (const [id,item] of Object.entries(next[key] || {})) if (item.expiresAt<Date.now()) delete next[key][id];
        const serialized=JSON.stringify(next);
        if (serialized.length>1024000) return reply({error:'ROOM_LIMIT'},409);
        const saved=await env.DB.prepare('UPDATE rooms SET state=?,revision=revision+1 WHERE code=? AND revision=?').bind(serialized,code,row.revision).run();
        if (saved.meta.changes) return reply({result});
      }
      return reply({error:'CONCURRENT_UPDATE_RETRY'},409);
    } catch (error) {
      const message=error?.message || 'BACKEND_ERROR';
      const known=/^(UNAUTHENTICATED|ACCOUNT_REQUIRED|TEST_MODE_DENIED|TEST_MODE_DISABLED|PROFILE_INVALID|PAYLOAD_TOO_LARGE|INVALID_JSON|NOT_MEMBER|HOST_ONLY|LOBBY_CLOSED|ROOM_FULL|NAME_IN_USE|INVALID_NAME|CENTER_REQUIRED|INVALID_GPS|STALE_CATCH|CATCH_RANGE_REQUIRED|TARGET_NOT_CATCHABLE|FRESH_GPS_REQUIRED|INVALID_POINT|INVALID_ZONE_SETTINGS|TASK_UNAVAILABLE|TASK_COOLDOWN|TASK_ALREADY_ACTIVE|TASK_EXPIRED|TASK_HIDER_NOT_NEARBY|NO_OBJECTIVES|INVALID_PHOTO|PHOTO_ALREADY_SUBMITTED|INVALID_CHALLENGE|WRONG_ANSWER|TASK_TOO_FAST|UNKNOWN_ACTION|RATE_LIMIT|FROZEN|RELOCATION_REQUIRED|RESTRICTED_AREA|POINTS_REQUIRED|ABILITY_COOLDOWN|ABILITY_UNAVAILABLE|SEEKER_NOT_NEARBY|SKILL_UNAVAILABLE|NO_ACTIVE_HIDERS|RELOCATION_PENDING|ZONE_LIMIT|EXCHANGE_LIMIT|MINIMUM_GAME_TIME|INVALID_ABILITY|NOT_ENOUGH_PLAYERS|NOT_ENOUGH_HIDERS|ROUND_RESTART_FAILED)$/.test(message);
      const status=message==='UNAUTHENTICATED'||message==='ACCOUNT_REQUIRED'?401:message==='TEST_MODE_DENIED'||message==='NOT_MEMBER'||message==='HOST_ONLY'?403:message==='RATE_LIMIT'?429:message==='PAYLOAD_TOO_LARGE'?413:message==='PROFILE_INVALID'?400:known?409:500;
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

async function readProfile(env,uid) {
  const row=await env.DB.prepare('SELECT display_name,cosmetic_id,sound_enabled,haptics_enabled FROM account_profiles WHERE uid=?').bind(uid).first();
  return row?{displayName:row.display_name,cosmeticId:row.cosmetic_id,soundEnabled:row.sound_enabled===1,hapticsEnabled:row.haptics_enabled===1}:{displayName:'',cosmeticId:'lime',soundEnabled:true,hapticsEnabled:true};
}
async function readJson(request,maxBytes) {
  const text=await request.text();
  if(new TextEncoder().encode(text).length>maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
  try { const value=JSON.parse(text); if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error(); return value; }
  catch { throw new Error('INVALID_JSON'); }
}
function constantTimeEqual(a,b) {
  const length=Math.max(a.length,b.length);let diff=a.length^b.length;
  for(let i=0;i<length;i++) diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);
  return diff===0;
}
