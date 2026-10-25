import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE_DIRS = ['js', 'worker', 'tests'];
const MARKERS = [/^<<<<<<< /m, /^=======\s*$/m, /^>>>>>>> /m];

async function sourceFiles(directory) {
  const files=[];
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    if(entry.isDirectory()) files.push(...await sourceFiles(path));
    else if(entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test('JavaScript and worker sources contain no unresolved merge-conflict markers',async()=>{
  const files=(await Promise.all(SOURCE_DIRS.map(sourceFiles))).flat();
  const failures=[];
  for(const file of files) {
    const source=await readFile(file,'utf8');
    if(MARKERS.some(marker=>marker.test(source))) failures.push(file);
  }
  assert.deepEqual(failures,[],'Resolve conflict markers before merging: '+failures.join(', '));
});
