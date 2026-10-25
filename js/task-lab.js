export const TASK_LAB_CATALOG = Object.freeze({
  hider:[
    {kind:'cipher',icon:'⌗',name:'Tresorcode knacken',description:'Löse das Zahlencode-Rätsel mit Positionshinweisen. Drei Versuche.',reward:25,duration:150},
    {kind:'visit',icon:'⌖',name:'Versteckter Zielpunkt',description:'Simuliere den Weg zu einem zufällig markierten Ziel in der Spielzone.',reward:30,duration:120},
    {kind:'stay',icon:'◷',name:'Versteck halten',description:'Halte deine Position 60 Sekunden. Im Testmodus kannst du die Zeit in Schritten vorspulen.',reward:20,duration:60},
    {kind:'photo',icon:'▧',name:'Versteck fotografieren',description:'Teste Kameraauswahl, Bildverkleinerung und Metadatenbereinigung lokal.',reward:25,duration:300}
  ],
  seeker:[
    {kind:'scan',icon:'⌖',name:'Signal Cache scannen',description:'Finde einen markierten, sicheren Trainings-Cache und schließe den Scan ab.',reward:25,duration:120},
    {kind:'proximity',icon:'◎',name:'Hider-Signal aufspüren',description:'Bringe den simulierten Hider auf höchstens 10 m heran und bestätige den Fund.',reward:25,duration:120}
  ]
});

function feedback(answer,guess) {
  let exact=0,present=0;
  for(let i=0;i<3;i++) { if(answer[i]===guess[i]) exact++; if(answer.includes(guess[i])) present++; }
  return {guess,exact,misplaced:present-exact};
}

function createPuzzle(random=Math.random) {
  const codes=[];
  for(let a=0;a<10;a++) for(let b=0;b<10;b++) for(let c=0;c<10;c++) if(a!==b&&a!==c&&b!==c) codes.push(`${a}${b}${c}`);
  const answer=codes[Math.min(codes.length-1,Math.floor(random()*codes.length))];
  const guesses=codes.filter(code=>code!==answer);
  for(let i=guesses.length-1;i>0;i--) { const j=Math.floor(random()*(i+1)); [guesses[i],guesses[j]]=[guesses[j],guesses[i]]; }
  let candidates=codes.slice();
  const clues=[];
  for(const guess of guesses) {
    const clue=feedback(answer,guess);
    const filtered=candidates.filter(candidate=>{
      const result=feedback(candidate,guess);
      return result.exact===clue.exact&&result.misplaced===clue.misplaced;
    });
    if(filtered.length<candidates.length) { clues.push(clue); candidates=filtered; }
    if(candidates.length===1) break;
  }
  return {answer,clues};
}

export function createTaskLabSession(role='seeker') {
  const safeRole=role==='hider'?'hider':'seeker';
  return {role:safeRole,active:null,completed:0,failed:0,credits:0,cooldownUntil:0,log:['Lokaler Aufgaben-Test bereit. Keine GPS-Daten oder Spielbelohnungen werden übertragen.']};
}

export function startTaskLabTask(session,kind,timestamp=Date.now(),random=Math.random) {
  if(!session||!TASK_LAB_CATALOG[session.role]?.some(task=>task.kind===kind)) return {ok:false,reason:'Diese Aufgabe ist für die gewählte Trainingsrolle nicht verfügbar.'};
  if(session.active) return {ok:false,reason:'Beende oder brich zuerst die aktive Trainingsaufgabe ab.'};
  if(session.cooldownUntil>timestamp) return {ok:false,reason:`Trainings-Cooldown: noch ${Math.ceil((session.cooldownUntil-timestamp)/1000)} Sekunden.`};
  const definition=TASK_LAB_CATALOG[session.role].find(task=>task.kind===kind);
  const active={kind,createdAt:timestamp,expiresAt:timestamp+definition.duration*1000,attemptsRemaining:3,elapsed:0,distanceMeters:35,arrived:false,photoData:null};
  if(kind==='cipher') active.puzzle=createPuzzle(random);
  session.active=active;
  session.log.unshift(`${definition.name} gestartet · ${definition.duration} Sekunden Testzeit.`);
  session.log=session.log.slice(0,8);
  return {ok:true,task:{...active,puzzle:active.puzzle?{clues:active.puzzle.clues}:undefined}};
}

export function setTaskLabDistance(session,distanceMeters) {
  if(session?.active?.kind!=='proximity') return false;
  session.active.distanceMeters=Math.max(0,Math.min(2000,Number(distanceMeters)||0));
  return true;
}

export function advanceTaskLabStay(session,seconds=15) {
  if(session?.active?.kind!=='stay') return false;
  session.active.elapsed=Math.min(60,session.active.elapsed+Math.max(1,Math.min(60,Number(seconds)||15)));
  return session.active.elapsed;
}

function fail(session,timestamp,message) {
  const kind=session.active?.kind;
  if(!kind) return {ok:false,reason:'Es läuft keine Trainingsaufgabe.'};
  session.active=null; session.failed++; session.cooldownUntil=timestamp+5000;
  session.log.unshift(message||'Trainingsversuch fehlgeschlagen · 5 Sekunden Cooldown.');
  session.log=session.log.slice(0,8);
  return {ok:false,failed:true,reason:message||'Trainingsversuch fehlgeschlagen.'};
}

export function completeTaskLabTask(session,proof={},timestamp=Date.now()) {
  const task=session?.active;
  if(!task) return {ok:false,reason:'Es läuft keine Trainingsaufgabe.'};
  if(timestamp>task.expiresAt) return fail(session,timestamp,'Zeit abgelaufen · Trainingsversuch fehlgeschlagen.');
  if(task.kind==='cipher') {
    const answer=String(proof.answer||'').trim();
    if(!/^\d{3}$/.test(answer)) return {ok:false,reason:'Gib genau drei Ziffern ein.'};
    if(answer!==task.puzzle.answer) {
      task.attemptsRemaining=Math.max(0,task.attemptsRemaining-1);
      if(task.attemptsRemaining===0) return fail(session,timestamp,'Drei Fehlversuche · 5 Sekunden Trainings-Cooldown.');
      const message=`Falscher Code · noch ${task.attemptsRemaining} ${task.attemptsRemaining===1?'Versuch':'Versuche'}.`;
      session.log.unshift(message); session.log=session.log.slice(0,8);
      return {ok:false,attemptsRemaining:task.attemptsRemaining,reason:message};
    }
  } else if(['visit','scan'].includes(task.kind)) {
    if(proof.arrived!==true) return {ok:false,reason:'Simuliere zuerst, dass du das Trainingsziel erreicht hast.'};
  } else if(task.kind==='stay') {
    if(task.elapsed<60) return {ok:false,reason:`Noch ${60-task.elapsed} Sekunden simulierte Standzeit.`};
  } else if(task.kind==='photo') {
    if(typeof proof.photoData!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(proof.photoData)||proof.photoData.length>24000) return {ok:false,reason:'Wähle ein Foto und lass es zuerst lokal verkleinern.'};
    task.photoData=proof.photoData;
  } else if(task.kind==='proximity') {
    if(task.distanceMeters>10) return {ok:false,reason:`Der Trainings-Hider ist noch ${Math.ceil(task.distanceMeters)} m entfernt. Maximal 10 m.`};
  }
  const definition=TASK_LAB_CATALOG[session.role].find(item=>item.kind===task.kind);
  session.active=null; session.completed++; session.credits+=definition.reward; session.cooldownUntil=timestamp+2000;
  const message=`${definition.name} im Testmodus geschafft · +${definition.reward} Test-Credits (nicht gespeichert).`;
  session.log.unshift(message); session.log=session.log.slice(0,8);
  return {ok:true,reward:definition.reward,credits:session.credits,message};
}

export function cancelTaskLabTask(session,timestamp=Date.now()) {
  return fail(session,timestamp,'Trainingsversuch abgebrochen · 5 Sekunden Cooldown.');
}

export function taskLabSnapshot(session,timestamp=Date.now()) {
  if(!session) return null;
  if(session.active&&timestamp>session.active.expiresAt) fail(session,timestamp,'Zeit abgelaufen · Trainingsversuch fehlgeschlagen.');
  return {
    role:session.role,active:session.active?{...session.active,puzzle:session.active.puzzle?{clues:session.active.puzzle.clues}:undefined}:null,
    completed:session.completed,failed:session.failed,credits:session.credits,cooldownSeconds:Math.max(0,Math.ceil((session.cooldownUntil-timestamp)/1000)),log:session.log.slice(0,8)
  };
}
