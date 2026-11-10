import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {createTools} from '../src/tools.mjs';
import {modelType} from '../src/engine.mjs';
import {extractSnapshot} from '../scripts/import-snapshot.mjs';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url)));
const rules = JSON.parse(readFileSync(new URL('../data/rules.json', import.meta.url)));
const tools = createTools({now: () => new Date('2026-11-10T00:00:00Z')});
const call = (name, args) => tools.callTool(name, args);
const base = () => JSON.parse(readFileSync(new URL('../examples/estimate.json', import.meta.url)));
const estimate = args => call('estimate_ai_core_cost', args);
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code);

test('browser-observed Standard, Batch and Evaluation totals', () => {
  const a = base();
  assert.equal(estimate(a).monthlyCUExact, '19.3240775');
  a.foundationModels[0].pricingMode = 'Batch';
  assert.equal(estimate(a).monthlyCUExact, '9.66203875');
  a.evaluation = {enabled: true, nodeHoursPerMonth: 30};
  assert.equal(estimate(a).monthlyCUExact, '26.04203875');
});
test('cache partitions add separately without charging full standard input twice', () => {
  const a = base();
  a.foundationModels[0] = {modelId: 'qwen3.8-max', version: 'latest', pricingMode: 'Cached', usage: {
    inputTokensPerRequest: 1000, outputTokensPerRequest: 1000, requestsPerMonth: 1,
    readCachedInputTokensPerRequest: 1000, writeCachedInputTokensPerRequest: 1000
  }};
  assert.equal(estimate(a).monthlyCUExact, '0.0113659845');
});
test('embedding fixture', () => {
  const a = {foundationModels: [{modelId:'text-embedding-v4',version:'latest',pricingMode:'Standard',usage:{inputTokensPerRequest:1000,requestsPerMonth:1000}}]};
  assert.equal(estimate(a).monthlyCUExact, '0.0951925');
});
test('all catalog versions and supported modes produce finite nonnegative values', () => {
  const types = new Set();
  let cases = 0;
  for (const model of catalog.models) for (const version of model.VERSION) {
    const mode = model.availability === 'internal' ? 'internal' : 'external';
    const p = call('get_model_pricing', {modelId:model.KEY,version:version.NAME,mode});
    types.add(modelType(model));
    for (const pricingMode of p.pricingModes) {
      const usage = Object.fromEntries([...p.usageByMode[pricingMode].required, ...p.usageByMode[pricingMode].optional].map(k => [k, 1000]));
      if (!version.READ_CACHED_INPUT_TOKENS) delete usage.readCachedInputTokensPerRequest;
      if (!(version.CACHE_WRITE_5M_TTL_INPUT_TOKENS ?? version.WRITE_CACHED_INPUT_TOKENS)) delete usage.writeCachedInputTokensPerRequest;
      const result = estimate({mode, foundationModels:[{modelId:model.KEY,version:version.NAME,pricingMode,usage}]});
      assert.ok(Number.isFinite(result.monthlyCU) && result.monthlyCU >= 0, model.KEY);
      cases++;
    }
  }
  assert.equal(types.size, 7);
  assert.ok(cases > 100);
});
test('orchestration factors and exceptions', () => {
  const result = estimate({orchestration:{enabled:true,
    contentFilter:{enabled:true,blocksPerMonth:1000},
    grounding:{enabled:true,queriesPerMonth:1000,storageGBDay:1},
    translation:{enabled:true,requestsPerMonth:1000},
    dataMasking:{enabled:true,requestsPerMonth:1000},
    inferenceObservability:{enabled:true,requestsPerMonth:1000}
  }});
  const lines = Object.fromEntries(result.lineItems.map(l => [l.label,l.monthlyCUExact]));
  assert.equal(lines.contentFilter,'0.571155');
  assert.equal(lines.groundingStorage,'0.205563');
  assert.equal(lines.inferenceObservability,'0.89');
  assert.equal(lines.groundingQueries,'5.107077625');
  assert.equal(lines.translation,'74.021688');
  assert.equal(lines.dataMasking,'2.246543');
});
test('Compute replica hours, baseline cap and storage', () => {
  const result = estimate({compute:{enabled:true,instances:[{instanceKey:'SAP:Starter',hoursPerMonth:730,replicas:2}],objectStorage:{enabled:true,storageGB:10}}});
  assert.equal(result.breakdown.computeInstances,'284.992');
  assert.equal(result.breakdown.computeBaseline,'893.593');
  assert.equal(result.breakdown.computeStorage,'2.19');
  assert.equal(result.monthlyCUExact,'1180.775');
});
test('Compute baseline uses actual hours before cap, never charged to GenAI alone', () => {
  const result = estimate({compute:{enabled:true,instances:[{instanceKey:'SAP:Starter',hoursPerMonth:10,replicas:2}]}});
  assert.equal(result.breakdown.computeBaseline,'24.482');
  assert.equal(estimate({compute:{enabled:true}}).monthlyCUExact,'0');
  assert.equal(estimate(base()).breakdown.computeBaseline,undefined);
});
test('disabled parent services produce no cost', () => {
  const result = estimate({orchestration:{enabled:false,contentFilter:{enabled:true,blocksPerMonth:1000}},compute:{enabled:false,objectStorage:{enabled:true,storageGB:10}}});
  assert.equal(result.monthlyCUExact,'0');
});
test('external currency requires explicit contract rate; internal weights each category', () => {
  assert.equal(estimate(base()).currency,null);
  const a = base();
  a.currency = {code:'KRW',ratePerCU:1500};
  assert.equal(estimate(a).currency.amount,'28986.11625');
  const result = estimate({mode:'internal',evaluation:{enabled:true,nodeHoursPerMonth:1},compute:{enabled:true,instances:[{instanceKey:'SAP:Starter',hoursPerMonth:1,replicas:1}]}});
  assert.equal(result.currency.amount,'0.970866');
});
test('explicit versions, availability and retirement warnings', () => {
  assert.equal(estimate(base()).warnings[0].code,'MODEL_RETIREMENT_DATE_PASSED');
  throwsCode(() => call('get_model_pricing',{modelId:'gpt4o',version:'invalid'}),'VERSION_NOT_FOUND');
  assert.ok(!call('list_models',{}).models.some(m=>m.modelId==='abapcodestral'));
  throwsCode(() => call('get_model_pricing',{modelId:'abapcodestral',version:'v1'}),'MODEL_NOT_FOUND');
});
test('bad quantities, typos, missing usage, invalid modes and unknown tools fail', () => {
  for (const bad of [-1, 0.5, '1000', Infinity, NaN, Number.MAX_SAFE_INTEGER+1]) {
    const a=base(); a.foundationModels[0].usage.inputTokensPerRequest=bad;
    throwsCode(()=>estimate(a),'INVALID_ARGUMENT');
  }
  throwsCode(()=>estimate({typo:true}),'INVALID_ARGUMENT');
  const a=base(); delete a.foundationModels[0].usage.outputTokensPerRequest;
  throwsCode(()=>estimate(a),'INVALID_ARGUMENT');
  throwsCode(()=>estimate({evaluation:{enabled:true}}),'INVALID_ARGUMENT');
  throwsCode(()=>call('toString',{}),'UNKNOWN_TOOL');
  throwsCode(()=>call('get_model_pricing',{modelId:'gpt4o',version:'2024-08-06',mode:'typo'}),'INVALID_ARGUMENT');
});
test('model-specific mode and irrelevant usage validation', () => {
  const a=base(); a.foundationModels[0].cacheDuration='1h';
  throwsCode(()=>estimate(a),'INVALID_ARGUMENT');
  a.foundationModels[0].pricingMode='Cached';
  throwsCode(()=>estimate(a),'INVALID_ARGUMENT');
  const b=base(); b.foundationModels[0].searchEffort='high';
  throwsCode(()=>estimate(b),'INVALID_ARGUMENT');
  b.foundationModels[0].usage.inputAudioTokensPerRequest=100;
  throwsCode(()=>estimate(b),'INVALID_ARGUMENT');
  const c={foundationModels:[{modelId:'text-embedding-v4',version:'latest',pricingMode:'Batch',usage:{inputTokensPerRequest:10,requestsPerMonth:1}}]};
  throwsCode(()=>estimate(c),'INVALID_ARGUMENT');
});
test('zero usage is zero; large integer usage retains exact decimal arithmetic', () => {
  const a=base(); a.foundationModels[0].usage.requestsPerMonth=0;
  assert.equal(estimate(a).monthlyCUExact,'0');
  a.foundationModels[0].usage={inputTokensPerRequest:1000,outputTokensPerRequest:0,requestsPerMonth:1000000000000};
  assert.equal(estimate(a).monthlyCUExact,'495001000');
});
test('policy changes alter results without editing engine; caller mutations are isolated', () => {
  const policy=structuredClone(rules); policy.batch.multiplier='0.25';
  const custom=createTools({catalog,rules:policy});
  const a=base(); a.foundationModels[0].pricingMode='Batch';
  assert.equal(custom.callTool('estimate_ai_core_cost',a).monthlyCUExact,'4.831019375');
  const result=estimate(base()); result.lineItems[0].appliedPrices.INPUT_TOKENS=999; result.source.site='bad';
  assert.equal(estimate(base()).monthlyCUExact,'19.3240775');
  assert.ok(estimate(base()).source.site.startsWith('https://'));
  assert.notEqual(custom.callTool('estimate_ai_core_cost',a).policyHash,estimate(a).policyHash);
});
test('CLI accepts file and function-call envelope; errors use nonzero exit status', () => {
  const cwd=new URL('..',import.meta.url);
  const result=JSON.parse(execFileSync(process.execPath,['src/cli.mjs','estimate_ai_core_cost','@examples/estimate.json'],{cwd,encoding:'utf8'}));
  assert.equal(result.monthlyCUExact,'19.3240775');
  const wrapped=JSON.parse(execFileSync(process.execPath,['src/cli.mjs','--call'],{cwd,input:JSON.stringify({name:'estimate_ai_core_cost',arguments:base()}),encoding:'utf8'}));
  assert.equal(wrapped.monthlyCUExact,result.monthlyCUExact);
  const invalid=spawnSync(process.execPath,['src/cli.mjs','estimate_ai_core_cost','{"bad":1}'],{cwd,encoding:'utf8'});
  assert.equal(invalid.status,1);
  assert.equal(JSON.parse(invalid.stderr).error.code,'INVALID_ARGUMENT');
  const all=JSON.parse(execFileSync(process.execPath,['src/cli.mjs','list_models'],{cwd,input:'',encoding:'utf8'}));
  assert.ok(all.models.length>0);
});
test('snapshot parser fails closed without executing remote expressions', () => {
  let executed=false;
  globalThis.__snapshotBad=()=>{executed=true;};
  assert.throws(()=>extractSnapshot('var a = { x: globalThis.__snapshotBad() };','test'));
  assert.equal(executed,false);
  delete globalThis.__snapshotBad;
});
test('148 golden cases from original browser calculation functions', () => {
  const golden=JSON.parse(readFileSync(new URL('./fixtures/browser-parity.json',import.meta.url)));
  assert.equal(golden.sourceBundleSHA256,catalog.pricingVersion,'Refresh browser fixtures after a catalog update');
  assert.equal(golden.fixtures.length,148);
  for(const fixture of golden.fixtures){
    const actual=estimate(fixture.arguments).monthlyCU;
    const expected=fixture.expectedMonthlyCU;
    assert.ok(Math.abs(actual-expected)<=Math.max(1e-8,Math.abs(expected)*1e-10),JSON.stringify(fixture.arguments));
  }
});
