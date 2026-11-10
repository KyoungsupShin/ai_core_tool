import {readFileSync} from 'node:fs';

const [activePath,candidatePath]=process.argv.slice(2);
if(!activePath||!candidatePath){
  console.error('Usage: node scripts/diff-snapshot.mjs active.json candidate.json');
  process.exitCode=1;
} else {
  const active=JSON.parse(readFileSync(activePath,'utf8'));
  const candidate=JSON.parse(readFileSync(candidatePath,'utf8'));
  const keyed=(values,key)=>new Map(values.map(v=>[key(v),v]));
  const diff=(a,b,key)=>{
    const previous=keyed(a,key), next=keyed(b,key);
    return {added:[...next.keys()].filter(k=>!previous.has(k)),removed:[...previous.keys()].filter(k=>!next.has(k)),changed:[...next.keys()].filter(k=>previous.has(k)&&JSON.stringify(previous.get(k))!==JSON.stringify(next.get(k)))};
  };
  const sections=['constants','orchestration','storage','baseline'];
  console.log(JSON.stringify({
    previousVersion:active.pricingVersion,candidateVersion:candidate.pricingVersion,
    models:diff(active.models,candidate.models,m=>m.KEY),
    instances:diff(active.instances,candidate.instances,m=>`${m.cloud}:${m.name}`),
    changedSections:sections.filter(k=>JSON.stringify(active[k])!==JSON.stringify(candidate[k])),
    policyReviewRequired:active.pricingVersion!==candidate.pricingVersion,
    note:'A bundle change may include calculation rule changes. Review rules.json and rerun source parity checks before activation. This command does not replace the active catalog.'
  },null,2));
}
