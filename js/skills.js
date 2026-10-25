export const SKILLS = {
  sonar: { id:'sonar', name:'Sonar / Radar-Ping', short:'Sonar Ping', icon:'◉', side:'seeker', price:35, strength:1.15, duration:5, description:'Zeigt Hider mit aktuellem GPS-Signal kurz als temporäre Marker.', action:'Hider orten' },
  tracker: { id:'tracker', name:'GPS-Tracker', short:'GPS-Tracker', icon:'⌖', side:'seeker', price:55, strength:1.35, duration:60, description:'Markiert den nächstgelegenen aktiven Hider.', action:'Nächsten Hider verfolgen' },
  jammer: { id:'jammer', name:'Radar-Jammer', short:'Radar-Jammer', icon:'ϟ', side:'seeker', price:45, strength:1.2, duration:45, description:'Stört die Radaranzeige aller Hider.', action:'Hider-Radar stören' },
  sprint: { id:'sprint', name:'Sprint-Alarm', short:'Sprint-Alarm', icon:'⚡', side:'seeker', price:30, strength:1.0, duration:20, description:'Aktiviert visuelle Bewegungs-Cues und einen kurzen Audioalarm.', action:'Bewegungsalarm aktivieren' },
  sweeper: { id:'sweeper', name:'Fallen-Räumer', short:'Fallen-Räumer', icon:'⌁', side:'seeker', price:40, strength:1.25, duration:0, description:'Entfernt digitale Fallen in deiner Nähe.', action:'Fallen im Umkreis räumen' },
  compass: { id:'compass', name:'Kompass-Pfeil', short:'Kompass-Pfeil', icon:'➤', side:'seeker', price:30, strength:1.05, duration:30, description:'Zeigt Richtung und Distanz zum entferntesten Hider.', action:'Entferntesten Hider anpeilen' },
  ghost: { id:'ghost', name:'Geist-Modus', short:'Geist-Modus', icon:'✧', side:'hider', price:35, strength:1.25, duration:45, description:'Verbirgt deinen GPS-Punkt vor Radar-Skills.', action:'GPS-Signatur verbergen' },
  decoy: { id:'decoy', name:'Täusch-Ping', short:'Täusch-Ping', icon:'◈', side:'hider', price:30, strength:1.0, duration:30, description:'Platziert einen gefälschten Marker auf der Seekers-Karte.', action:'Täusch-Marker platzieren' },
  trap: { id:'trap', name:'Digitale Falle / EMP', short:'EMP-Falle', icon:'⌗', side:'hider', price:45, strength:1.3, duration:15, description:'Stört Seeker im Wirkungsradius.', action:'Falle an deiner Position setzen' },
  shield: { id:'shield', name:'Schild / Zweite Chance', short:'Schild', icon:'⬡', side:'hider', price:50, strength:1.4, duration:0, description:'Blockiert einen Fangversuch einmalig.', action:'Schild aktivieren' },
  seekerradar: { id:'seekerradar', name:'Seeker-Radar', short:'Seeker-Radar', icon:'◎', side:'hider', price:40, strength:1.2, duration:10, description:'Zeigt bekannte Seeker-Positionen kurz live.', action:'Seeker orten' },
  silent: { id:'silent', name:'Leise Sohlen', short:'Leise Sohlen', icon:'♧', side:'hider', price:25, strength:0.9, duration:120, description:'Deaktiviert automatische Nähewarnungen.', action:'Leise Sohlen aktivieren' }
};

export const SKILL_IDS = Object.keys(SKILLS);
export const DEFAULT_SETTINGS = {
  mode: 'classic', hideDuration: 180, gameDuration: 1200, radius: 500, announcements: true, seekerCount: 1,
  skills: Object.fromEntries(SKILL_IDS.map((id) => [id, true]))
};

export function eligibleSkills(settings, side) {
  return SKILL_IDS.filter((id) => settings?.skills?.[id] !== false && SKILLS[id].side === side);
}

export function skillTuning(skillId, radius=500) {
  const skill = SKILLS[skillId];
  if (!skill) return null;
  const zone = Math.max(50, Math.min(2000, Number(radius) || 500));
  const zoneScale = Math.sqrt(zone / 500);
  const price = Math.max(10, Math.round((skill.price * (0.8 + skill.strength * 0.2) * (0.82 + zoneScale * 0.18)) / 5) * 5);
  const duration = skill.duration ? Math.max(5, Math.round(skill.duration * (0.82 + zoneScale * 0.18))) : 0;
  return { ...skill, price, duration, zoneRadius:zone,
    sweepRadius:Math.round(Math.max(45,Math.min(zone*0.3,zone*0.3))),
    trapRadius:Math.round(Math.max(12,Math.min(50,zone*0.05))),
    decoyRange:Math.round(Math.max(30,Math.min(zone*0.35,zone*0.35))) };
}
