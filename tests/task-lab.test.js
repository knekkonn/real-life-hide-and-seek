import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_LAB_CATALOG, createTaskLabSession, startTaskLabTask, setTaskLabDistance, advanceTaskLabStay, advanceTaskLabCloseCall, completeTaskLabTask, cancelTaskLabTask, taskLabSnapshot } from '../js/task-lab.js';

test('task lab exposes only the tasks belonging to the selected practice role',()=>{
  const hider=createTaskLabSession('hider'),seeker=createTaskLabSession('seeker');
  assert.deepEqual(TASK_LAB_CATALOG.hider.map(task=>task.kind),['cipher','visit','stay','photo','closecall']);
  assert.deepEqual(TASK_LAB_CATALOG.seeker.map(task=>task.kind),['scan','proximity']);
  assert.equal(startTaskLabTask(seeker,'cipher',1000).ok,false);
  assert.equal(startTaskLabTask(hider,'scan',1000).ok,false);
});

test('sandbox code puzzle is uniquely solvable and supports three attempts',()=>{
  const session=createTaskLabSession('hider'),started=startTaskLabTask(session,'cipher',1000,()=>.314159);
  assert.equal(started.ok,true);
  const clues=started.task.puzzle.clues;
  let candidates=[];
  for(let a=0;a<10;a++) for(let b=0;b<10;b++) for(let c=0;c<10;c++) {
    const code=`${a}${b}${c}`;if(a===b||a===c||b===c)continue;
    const matches=clues.every(clue=>{
      let exact=0,present=0;for(let i=0;i<3;i++){if(code[i]===clue.guess[i])exact++;if(code.includes(clue.guess[i]))present++;}
      return exact===clue.exact&&present-exact===clue.misplaced;
    });if(matches)candidates.push(code);
  }
  assert.deepEqual(candidates,[session.active.puzzle.answer]);
  const wrong=['000','111','222'].find(code=>code!==session.active.puzzle.answer);
  assert.equal(completeTaskLabTask(session,{answer:wrong},2000).attemptsRemaining,2);
  assert.equal(completeTaskLabTask(session,{answer:wrong},3000).attemptsRemaining,1);
  const won=completeTaskLabTask(session,{answer:session.active.puzzle.answer},4000);
  assert.equal(won.ok,true);assert.equal(session.credits,25);assert.equal(session.active,null);
});

test('visit and cache tests complete only after simulated arrival and award sandbox credits',()=>{
  const hider=createTaskLabSession('hider');
  startTaskLabTask(hider,'visit',1000);
  assert.equal(completeTaskLabTask(hider,{},2000).ok,false);
  assert.equal(completeTaskLabTask(hider,{arrived:true},3000).ok,true);
  const seeker=createTaskLabSession('seeker');
  startTaskLabTask(seeker,'scan',1000);
  assert.equal(completeTaskLabTask(seeker,{arrived:true},3000).ok,true);
  assert.equal(seeker.credits,25);
});

test('stay challenge uses controllable simulated time and expires without real GPS',()=>{
  const session=createTaskLabSession('hider');
  startTaskLabTask(session,'stay',1000);
  advanceTaskLabStay(session,15);advanceTaskLabStay(session,15);
  assert.equal(completeTaskLabTask(session,{},2000).ok,false);
  advanceTaskLabStay(session,15);advanceTaskLabStay(session,15);
  assert.equal(taskLabSnapshot(session,2000).active.elapsed,60);
  assert.equal(completeTaskLabTask(session,{},2000).ok,true);
});

test('photo test accepts only a compressed JPEG data URL and keeps it out of the results log',()=>{
  const session=createTaskLabSession('hider');startTaskLabTask(session,'photo',1000);
  assert.equal(completeTaskLabTask(session,{photoData:'large-original-file'},2000).ok,false);
  const photoData='data:image/jpeg;base64,AA==';
  assert.equal(completeTaskLabTask(session,{photoData},3000).pending,true);
  assert.equal(session.credits,0);
  for(let i=0;i<12;i++) advanceTaskLabStay(session,15);
  const result=completeTaskLabTask(session,{photoData},4000);
  assert.equal(result.credits,45);
  assert.equal(result.ok,true);assert.equal(session.active,null);
  assert.ok(session.log.every(line=>!line.includes('data:image')));
});

test('proximity task enforces ten metres, cancellation and a short test cooldown',()=>{
  const session=createTaskLabSession('seeker');startTaskLabTask(session,'proximity',1000);
  assert.equal(completeTaskLabTask(session,{},2000).ok,false);
  setTaskLabDistance(session,10);
  assert.equal(completeTaskLabTask(session,{},2000).ok,true);
  startTaskLabTask(session,'proximity',5000);
  assert.equal(cancelTaskLabTask(session,6000).failed,true);
  assert.equal(startTaskLabTask(session,'proximity',7000).ok,false);
  assert.equal(startTaskLabTask(session,'proximity',12000).ok,true);
});

