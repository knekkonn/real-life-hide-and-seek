export const COSMETIC_IDS=Object.freeze(['lime','cyan','violet','amber','rose']);
export function normalizeAccountProfile(input,fallback={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)) throw new Error('PROFILE_INVALID');
  const displayName=typeof input.displayName==='string'?input.displayName.trim().replace(/\s+/g,' '):(fallback.displayName||'');
  const cosmeticId=typeof input.cosmeticId==='string'?input.cosmeticId:(fallback.cosmeticId||'lime');
  if(displayName.length<2||displayName.length>18||! /^[\p{L}\p{N}_ -]+$/u.test(displayName)) throw new Error('PROFILE_INVALID');
  if(!COSMETIC_IDS.includes(cosmeticId)) throw new Error('PROFILE_INVALID');
  const soundEnabled=typeof input.soundEnabled==='boolean'?input.soundEnabled:fallback.soundEnabled!==false;
  const hapticsEnabled=typeof input.hapticsEnabled==='boolean'?input.hapticsEnabled:fallback.hapticsEnabled!==false;
  return {displayName,cosmeticId,soundEnabled,hapticsEnabled};
}
