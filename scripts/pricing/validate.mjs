import {createTools} from '../../src/tools.mjs';

export function validateCandidate(catalog, rules) {
  const require = (ok, message) => { if (!ok) throw Error(`Invalid pricing candidate: ${message}`); };
  const price = (value, label) => {
    if (typeof value === 'number') require(Number.isFinite(value) && value >= 0, label);
    else {
      require(value && typeof value === 'object' && !Array.isArray(value), label);
      for (const mode of ['external', 'internal']) price(value[mode], `${label}.${mode}`);
    }
  };
  const unique = (items, key, label) => require(new Set(items.map(key)).size === items.length, `duplicate ${label}`);
  require(catalog.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(catalog.pricingVersion), 'source hash/schema');
  require(catalog.models?.length > 0 && catalog.instances?.length > 0, 'empty catalog');
  unique(catalog.models, m => m.KEY, 'model ID');
  unique(catalog.instances, m => `${m.cloud}:${m.name}`, 'instance key');
  price(catalog.constants.CAPACITY_UNITS_PER_TOKEN, 'CU multiplier');
  require(catalog.constants.CAPACITY_UNITS_PER_TOKEN > 0, 'CU multiplier must be positive');
  require(Number.isInteger(catalog.constants.HOURS_PER_MONTH) && catalog.constants.HOURS_PER_MONTH > 0, 'monthly hours');
  for (const key of ['contentFilter','grounding','groundingStorage','translation','dataMasking','inferenceObservability']) price(catalog.orchestration[key], key);
  price(catalog.orchestration.translationBlocksPerCall, 'translation blocks');
  for (const item of [catalog.storage, catalog.baseline, ...catalog.instances]) price(item.pricePerHour, item.name);
  const requiredRates = model => {
    const c = model.CAPABILITIES;
    if (c.includes('reranking')) return ['SEARCH_UNITS'];
    if (c.includes('tabular')) return ['NUM_INPUT_CELLS', 'NUM_PREDICTION'];
    return c.includes('embedding') ? ['INPUT_TOKENS'] : ['INPUT_TOKENS', 'OUTPUT_TOKENS'];
  };
  for (const model of catalog.models) {
    require(typeof model.KEY === 'string' && model.KEY.length > 0 && Array.isArray(model.CAPABILITIES) && Array.isArray(model.INPUT_TYPES), 'model shape');
    require(model.VERSION?.length > 0 && ['internal','external','both'].includes(model.availability), `${model.KEY} versions/availability`);
    unique(model.VERSION, v => v.NAME, `${model.KEY} version`);
    for (const version of model.VERSION) {
      require(typeof version.NAME === 'string' && version.NAME.length > 0, `${model.KEY} version name`);
      for (const key of requiredRates(model)) price(version[key], `${model.KEY}/${version.NAME}/${key}`);
      for (const [key, value] of Object.entries(version)) {
        if (/TOKENS$|^NUM_|^SEARCH_UNITS$/.test(key)) price(value, `${model.KEY}/${key}`);
        if (key === 'API_CALLS_PRICING') for (const amount of Object.values(value)) price(amount, 'search price');
      }
    }
  }
  const tools = createTools({catalog, rules});
  let checkedCases = 0;
  for (const model of catalog.models) for (const version of model.VERSION) {
    const mode = model.availability === 'internal' ? 'internal' : 'external';
    const pricing = tools.callTool('get_model_pricing', {modelId: model.KEY, version: version.NAME, mode});
    for (const pricingMode of pricing.pricingModes) {
      const spec = pricing.usageByMode[pricingMode];
      const usage = Object.fromEntries(spec.required.map(field => [field, 1000]));
      const quote = tools.callTool('estimate_ai_core_cost', {mode, foundationModels: [{modelId: model.KEY, version: version.NAME, pricingMode, usage}]});
      require(Number.isFinite(quote.monthlyCU) && quote.monthlyCU >= 0, `${model.KEY} estimate`);
      checkedCases++;
    }
  }
  return {valid: true, models: catalog.models.length, instances: catalog.instances.length, checkedCases};
}
