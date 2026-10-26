import { bearingDegrees, destinationPoint, distanceMeters } from '../js/utils.js';

const ACCESSIBLE_HIGHWAYS = new Set(['footway','path','pedestrian','steps','track','cycleway']);
const SIDEWALK_HIGHWAYS = new Set(['residential','service','tertiary','secondary','unclassified','living_street']);
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
  const mappedSidewalk=['both','left','right','yes','separate'].includes(tags.sidewalk);
  const walkway=ACCESSIBLE_HIGHWAYS.has(tags.highway) || SIDEWALK_HIGHWAYS.has(tags.highway)&&mappedSidewalk;
  return walkway && !restricted(tags) && (footAllowed || !tags.foot) && !(tags.cycleway==='no');
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
  if(!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng) || !Number.isFinite(radius) || radius<50 || radius>2000) return [];
  // Only a coarse centre and slightly padded radius go to public map servers.
  // All final zone and safety checks still use the exact point in this Worker.
  const queryLat=Math.round(center.lat*1000)/1000,queryLng=Math.round(center.lng*1000)/1000,queryRadius=Math.min(2200,radius+120);
  const query=`[out:json][timeout:8];(way(around:${queryRadius},${queryLat},${queryLng})["highway"~"^(footway|path|pedestrian|steps|track|cycleway)$"];way(around:${queryRadius},${queryLat},${queryLng})["highway"~"^(residential|service|tertiary|secondary|unclassified|living_street)$"]["sidewalk"~"^(both|left|right|yes|separate)$"];way(around:${queryRadius},${queryLat},${queryLng})["access"~"^(no|private|customers|permit)$"];way(around:${queryRadius},${queryLat},${queryLng})["foot"~"^(no|private)$"];way(around:${queryRadius},${queryLat},${queryLng})["building"]["building"!="no"];way(around:${queryRadius},${queryLat},${queryLng})["landuse"="military"];way(around:${queryRadius},${queryLat},${queryLng})["natural"="water"];way(around:${queryRadius},${queryLat},${queryLng})["waterway"];way(around:${queryRadius},${queryLat},${queryLng})["leisure"="nature_reserve"];way(around:${queryRadius},${queryLat},${queryLng})["boundary"="protected_area"];way(around:${queryRadius},${queryLat},${queryLng})["amenity"="prison"];way(around:${queryRadius},${queryLat},${queryLng})["power"="plant"];rel(around:${queryRadius},${queryLat},${queryLng})["access"~"^(no|private|customers|permit)$"];rel(around:${queryRadius},${queryLat},${queryLng})["building"]["building"!="no"];rel(around:${queryRadius},${queryLat},${queryLng})["landuse"="military"];rel(around:${queryRadius},${queryLat},${queryLng})["natural"="water"];rel(around:${queryRadius},${queryLat},${queryLng})["waterway"];rel(around:${queryRadius},${queryLat},${queryLng})["leisure"="nature_reserve"];rel(around:${queryRadius},${queryLat},${queryLng})["boundary"="protected_area"];rel(around:${queryRadius},${queryLat},${queryLng})["amenity"="prison"];rel(around:${queryRadius},${queryLat},${queryLng})["power"="plant"];);out tags geom;`;
  let data=null;
  for(const endpoint of ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter']) {
    try {
      const response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json'},body:`data=${encodeURIComponent(query)}`,signal:AbortSignal.timeout(10000)});
      const length=Number(response.headers?.get?.('content-length')||0);
      if(!response.ok || length>4_000_000) continue;
      const candidate=await response.json();
      if(!Array.isArray(candidate?.elements) || JSON.stringify(candidate).length>4_000_000) continue;
      data=candidate;
      if(candidate.elements.length) break;
    } catch { /* retry on a later bounded room refresh */ }
  }
  try {
    if(!data) return [];
    const blocked=data.elements.filter(e=>e.type==='way' && restricted(e.tags) && e.geometry?.length>=2).map(e=>e.geometry.map(p=>({lat:p.lat, lng:p.lon})));
    for(const relation of data.elements.filter(e=>e.type==='relation' && restricted(e.tags))) blocked.push(...relationRings(relation.members));
    const segments=[];
    for(const way of data.elements) {
      if(way.type!=='way' || !usablePath(way.tags) || !Array.isArray(way.geometry)) continue;
      for(let i=1;i<way.geometry.length;i++) {
        const a={lat:way.geometry[i-1].lat,lng:way.geometry[i-1].lon}, b={lat:way.geometry[i].lat,lng:way.geometry[i].lon};
        const length=distanceMeters(a,b);
        // OSM ways are split into short segments around intersections, but long
        // straight mapped paths are common too. Keep those and sample only the
        // part that actually falls inside the play circle below.
        if(length>=8 && length<=500) segments.push({a,b,length,level:way.tags.level??null,layer:way.tags.layer??null,sidewalk:!ACCESSIBLE_HIGHWAYS.has(way.tags.highway)});
      }
    }
    const result=[];
    for(let attempt=0;attempt<segments.length*3 && result.length<5;attempt++) {
      const segment=segments[Math.floor(Math.random()*segments.length)]; if(!segment) break;
      const fraction=.05+Math.random()*.9;
      let point=destinationPoint(segment.a,segment.length*fraction,bearingDegrees(segment.a,segment.b));
      if(segment.sidewalk) point=destinationPoint(point,4,bearingDegrees(segment.a,segment.b)+(Math.random()<.5?90:270));
      if(distanceMeters(center,point)>radius-Math.min(20,radius*.2) || blocked.some(p=>nearPolygon(point,p))) continue;
      if(result.some(existing=>distanceMeters(existing.location,point)<Math.min(80,radius*.7))) continue;
      const value={location:point};
      if(segment.level!==null && /^[+-]?\d{1,2}(?:\.\d+)?$/.test(String(segment.level))) value.level=Number(segment.level);
      if(segment.layer!==null && /^[+-]?\d{1,2}(?:\.\d+)?$/.test(String(segment.layer))) value.layer=Number(segment.layer);
      result.push(value);
    }
    return result;
  } catch { return []; }
}
