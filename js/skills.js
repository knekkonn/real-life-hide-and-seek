export const SKILLS = {
  sonar: { id:'sonar', name:'Sonar / Radar-Ping', short:'Sonar Ping', icon:'◉', side:'seeker', price:35, duration:5, description:'Zeigt Hider mit aktuellem GPS-Signal 5 Sekunden lang als temporäre Marker.', action:'Hider für 5 Sekunden orten' },
  tracker: { id:'tracker', name:'GPS-Tracker', short:'GPS-Tracker', icon:'⌖', side:'seeker', price:55, duration:60, description:'Markiert den nächstgelegenen aktiven Hider 60 Sekunden lang.', action:'Nächsten Hider verfolgen' },
  jammer: { id:'jammer', name:'Radar-Jammer', short:'Radar-Jammer', icon:'ϟ', side:'seeker', price:45, duration:45, description:'Stört die Radaranzeige aller Hider für 45 Sekunden.', action:'Hider-Radar stören' },
  sprint: { id:'sprint', name:'Sprint-Alarm', short:'Sprint-Alarm', icon:'⚡', side:'seeker', price:30, duration:20, description:'Aktiviert visuelle Bewegungs-Cues und einen kurzen Audioalarm.', action:'Bewegungsalarm aktivieren' },
  sweeper: { id:'sweeper', name:'Fallen-Räumer', short:'Fallen-Räumer', icon:'⌁', side:'seeker', price:40, duration:0, description:'Entfernt digitale Fallen in der Nähe (innerhalb von 150 m).', action:'Fallen im Umkreis räumen' },
  compass: { id:'compass', name:'Kompass-Pfeil', short:'Kompass-Pfeil', icon:'➤', side:'seeker', price:30, duration:30, description:'Zeigt 30 Sekunden lang die Richtung zum entferntesten Hider.', action:'Entferntesten Hider anpeilen' },
  ghost: { id:'ghost', name:'Geist-Modus', short:'Geist-Modus', icon:'✧', side:'hider', price:35, duration:45, description:'Verbirgt deinen GPS-Punkt 45 Sekunden lang vor Radar-Skills.', action:'GPS-Signatur verbergen' },
  decoy: { id:'decoy', name:'Täusch-Ping', short:'Täusch-Ping', icon:'◈', side:'hider', price:30, duration:30, description:'Platziert einen gefälschten Marker auf der Seekers-Karte.', action:'Täusch-Marker platzieren' },
  trap: { id:'trap', name:'Digitale Falle / EMP', short:'EMP-Falle', icon:'⌗', side:'hider', price:45, duration:15, description:'Platziert eine digitale Falle, die Seeker in der Nähe für 15 Sekunden stört.', action:'Falle an deiner Position setzen' },
  shield: { id:'shield', name:'Schild / Zweite Chance', short:'Schild', icon:'⬡', side:'hider', price:50, duration:0, description:'Blockiert einen Fangversuch einmalig. Der Seeker muss erneut anfragen.', action:'Schild aktivieren' },
  seekerradar: { id:'seekerradar', name:'Seeker-Radar', short:'Seeker-Radar', icon:'◎', side:'hider', price:40, duration:10, description:'Zeigt die bekannten Seeker-Positionen für 10 Sekunden live.', action:'Seeker 10 Sekunden orten' },
  silent: { id:'silent', name:'Leise Sohlen', short:'Leise Sohlen', icon:'♧', side:'hider', price:25, duration:120, description:'Deaktiviert automatische Nähewarnungen für zwei Minuten.', action:'Leise Sohlen aktivieren' }
};

export const SKILL_IDS = Object.keys(SKILLS);
export const DEFAULT_SETTINGS = {
  mode: 'classic', hideDuration: 180, gameDuration: 1200, radius: 500, announcements: true, seekerCount: 1,
  skills: Object.fromEntries(SKILL_IDS.map((id) => [id, true]))
};

export function eligibleSkills(settings, side) {
  return SKILL_IDS.filter((id) => settings?.skills?.[id] !== false && SKILLS[id].side === side);
}
