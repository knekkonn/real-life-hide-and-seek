import { bearingDegrees, destinationPoint, distanceMeters } from '../js/utils.js';

const ACCESSIBLE_HIGHWAYS = new Set(['footway','path','pedestrian','steps','track','cycleway']);
const DENIED = /^(no|private|customers|permit)$/i;

function insidePolygon(point, polygon) {
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const a=polygon[i], b=polygon[j];
    if(((a.lat>point.lat)!==(b.lat>point.lat)) && point.lng<(b.lng-a.lng)*(point.lat-a.lat)/(b.lat-a.lat)+a.lng) inside=!inside;
  }
  return inside;
}
function nearPolygon(point, polygon, threshold=15) {
  if(insidePolygon(point,polygon)) return true;
  // Equirectangular projection is accurate enough for a short safety margin.
  const latScale=111320, lngScale=111320*Math.cos(point.lat*Math.PI/180);
  for(let i=0;i<polygon.length;i++) {
    const a=polygon[i], b=polygon[(i+1)%polygon.length];
    const ax=(a.lng-point.lng)*lngScale, ay=(a.lat-point.lat)*latScale;
    const bx=(b.lng-point.lng)*lngScale, by=(b.lat-point.lat)*latScale;
    const dx=bx-ax, dy=by-ay, t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
    if(Math.hypot(ax+t*dx,ay+t*dy)<threshold) return true;
  }
  return false;
}
function restricted(tags={}) {
  return DENIED.test(tags.access||'') || DENIED.test(tags.foot||'') ||
    tags.building && tags.building!=='no' || tags.landuse==='military' ||
    tags.natural==='water' || tags.waterway || tags.leisure==='nature_reserve' ||
    tags.boundary==='protected_area' || tags.amenity==='prison' || tags.power==='plant';
}
function usablePath(tags={}) {
  const footAllowed=['yes','designated','permissive'].includes(tags.foot);
  return ACCESSIBLE_HIGHWAYS.has(tags.highway) && !restricted(tags) &&
    (footAllowed || !tags.foot) && !(tags.cycleway==='no');
}
function relationRings(members=[]) {
  const lines=members.filter(m=>m.type==='way' && Array.isArray(m.geometry) && m.geometry.length>=2).map(m=>m.geometry.map(p=>({lat:p.lat,lng:p.lon})));
  const rings=[];
  while(lines.length) {
    const chain=lines.shift();
    let changed=true;
    while(changed) {
      changed=false;
      for(let i=0;i<lines.length;i++) {
        const line=lines[i], start=chain[0], end=chain[chain.length-1];
        const same=(a,b)=>Math.abs(a.lat-b.lat)<1e-8 && Math.abs(a.lng-b.lng)<1e-8;
        if(same(end,line[0])) chain.push(...line.slice(1));
        else if(same(end,line.at(-1))) chain.push(...line.slice(0,-1).reverse());
        else if(same(start,line.at(-1))) chain.unshift(...line.slice(0,-1));
        else if(same(start,line[0])) chain.unshift(...line.slice(1).reverse());
        else continue;
        lines.splice(i,1);changed=true;break;
      }
    }
    if(chain.length>=4 && Math.abs(chain[0].lat-chain.at(-1).lat)<1e-8 && Math.abs(chain[0].lng-chain.at(-1).lng)<1e-8) rings.push(chain);
    else if(chain.length>=2) rings.push(chain); // Incomplete protected boundaries remain blocked within the safety margin.
  }
  return rings;
}

export async function findSafeItemLocations(center,radius,fetchImpl=fetch) {
  if(!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng) || !Number.isFinite(radius) || radius<100 || radius>2000) return [];
  const query=`[out:json][timeout:8];(way(around:${radius},${center.lat},${center.lng})["highway"~"^(footway|path|pedestrian|steps|track|cycleway)$"];way(around:${radius},${center.lat},${center.lng})["access"~"^(no|private|customers|permit)$"];way(around:${radius},${center.lat},${center.lng})["foot"~"^(no|private)$"];way(around:${radius},${center.lat},${center.lng})["building"]["building"!="no"];way(around:${radius},${center.lat},${center.lng})["landuse"="military"];way(around:${radius},${center.lat},${center.lng})["natural"="water"];way(around:${radius},${center.lat},${center.lng})["waterway"];way(around:${radius},${center.lat},${center.lng})["leisure"="nature_reserve"];way(around:${radius},${center.lat},${center.lng})["boundary"="protected_area"];way(around:${radius},${center.lat},${center.lng})["amenity"="prison"];way(around:${radius},${center.lat},${center.lng})["power"="plant"];rel(around:${radius},${center.lat},${center.lng})["access"~"^(no|private|customers|permit)$"];rel(around:${radius},${center.lat},${center.lng})["building"]["building"!="no"];rel(around:${radius},${center.lat},${center.lng})["landuse"="military"];rel(around:${radius},${center.lat},${center.lng})["natural"="water"];rel(around:${radius},${center.lat},${center.lng})["waterway"];rel(around:${radius},${center.lat},${center.lng})["leisure"="nature_reserve"];rel(around:${radius},${center.lat},${center.lng})["boundary"="protected_area"];rel(around:${radius},${center.lat},${center.lng})["amenity"="prison"];rel(around:${radius},${center.lat},${center.lng})["power"="plant"];);out tags geom;`;
  let response;
  try {
    response=await fetchImpl('https://overpass-api.de/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json'},body:`data=${encodeURIComponent(query)}`,signal:AbortSignal.timeout(10000)});
    const length=Number(response.headers?.get?.('content-length')||0);
    if(!response.ok || length>4_000_000) return [];
    const data=await response.json();
    if(!Array.isArray(data?.elements) || JSON.stringify(data).length>4_000_000) return [];
    const blocked=data.elements.filter(e=>e.type==='way' && restricted(e.tags) && e.geometry?.length>=2).map(e=>e.geometry.map(p=>({lat:p.lat, lng:p.lon})));
    for(const relation of data.elements.filter(e=>e.type==='relation' && restricted(e.tags))) blocked.push(...relationRings(relation.members));
    const segments=[];
    for(const way of data.elements) {
      if(way.type!=='way' || !usablePath(way.tags) || !Array.isArray(way.geometry)) continue;
      for(let i=1;i<way.geometry.length;i++) {
        const a={lat:way.geometry[i-1].lat,lng:way.geometry[i-1].lon}, b={lat:way.geometry[i].lat,lng:way.geometry[i].lon};
        const length=distanceMeters(a,b);
        if(length>=8 && length<=120 && distanceMeters(center,a)<radius && distanceMeters(center,b)<radius) segments.push({a,b,length,level:way.tags.level??null,layer:way.tags.layer??null});
      }
    }
    const result=[];
    for(let attempt=0;attempt<segments.length*3 && result.length<5;attempt++) {
      const segment=segments[Math.floor(Math.random()*segments.length)]; if(!segment) break;
      const fraction=.15+Math.random()*.7;
      const point=destinationPoint(segment.a,segment.length*fraction,bearingDegrees(segment.a,segment.b));
      if(distanceMeters(center,point)>radius-20 || blocked.some(p=>nearPolygon(point,p))) continue;
      if(result.some(existing=>distanceMeters(existing.location,point)<80)) continue;
      const value={location:point};
      if(segment.level!==null && /^[+-]?\d{1,2}(?:\.\d+)?$/.test(String(segment.level))) value.level=Number(segment.level);
      if(segment.layer!==null && /^[+-]?\d{1,2}(?:\.\d+)?$/.test(String(segment.layer))) value.layer=Number(segment.layer);
      result.push(value);
    }
    return result;
  } catch { return []; }
}
