import {readFileSync} from 'node:fs';
import {compareSnapshots} from './pricing/diff.mjs';

const [activePath,candidatePath]=process.argv.slice(2);
if(!activePath||!candidatePath){
  console.error('Usage: node scripts/diff-snapshot.mjs active.json candidate.json');
  process.exitCode=1;
} else {
  const active=JSON.parse(readFileSync(activePath,'utf8'));
  const candidate=JSON.parse(readFileSync(candidatePath,'utf8'));
  console.log(JSON.stringify(compareSnapshots(active,candidate),null,2));
}
