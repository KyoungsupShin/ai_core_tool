import Decimal from 'decimal.js';
import {createHash} from 'node:crypto';

const D = Decimal.clone({precision: 60});
const dec = value => new D(value);
const zero = () => dec(0);
const sum = values => values.reduce((a, b) => a.plus(b), zero());
export class ToolError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const fail = (message) => { throw new ToolError('INVALID_ARGUMENT', message); };
const choose = (value, mode) => typeof value === 'object' && value !== null ? value[mode] : value;
const visible = (item, mode) => !item.availability || item.availability === 'both' || item.availability === mode;

export function modelType(model) {
  const c = model.CAPABILITIES;
  if (c.includes('reranking')) return 'reranker';
  if (c.includes('speech-to-speech')) return 'realtime';
  if (c.includes('image-generation')) return 'image-gen';
  if (c.includes('tabular')) return 'tabular';
  if (c.includes('embedding')) return model.INPUT_TYPES.some(t => ['image', 'audio', 'video'].includes(t)) ? 'multimodal-embedding' : 'embedding';
  return 'text-gen';
}

const baseFields = {
  'text-gen': ['inputTokensPerRequest', 'outputTokensPerRequest', 'requestsPerMonth'],
  embedding: ['inputTokensPerRequest', 'requestsPerMonth'],
  'multimodal-embedding': ['inputTokensPerRequest', 'requestsPerMonth'],
  realtime: ['inputTextTokensPerRequest', 'outputTextTokensPerRequest', 'inputAudioTokensPerRequest', 'outputAudioTokensPerRequest', 'requestsPerMonth'],
  'image-gen': ['inputTokensPerRequest', 'outputTokensPerRequest', 'inputImageTokensPerRequest', 'outputImageTokensPerRequest', 'requestsPerMonth'],
  reranker: ['queriesPerMonth'],
  tabular: ['contextCellsPerPrediction', 'predictedCellsPerPrediction', 'predictionsPerMonth']
};

export function createEngine(catalog, rules, {now = () => new Date()} = {}) {
  if (catalog.schemaVersion !== 1 || !catalog.models?.length || !catalog.instances?.length) throw Error('Unsupported or empty catalog');
  const formatted = value => dec(value).toDecimalPlaces(rules.rounding.decimalPlaces, D[rules.rounding.mode]).toFixed();
  const policyHash = createHash('sha256').update(JSON.stringify(rules)).digest('hex');
  const catalogHash = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  const metadata = () => ({pricingVersion: catalog.pricingVersion, catalogHash, policyVersion: rules.policyVersion, policyHash, calculatorVersion: rules.calculatorVersion, source: catalog.source});
  const unitPrice = (value, mode) => {
    const result = choose(value, mode);
    if (result === undefined || !dec(result).isFinite() || dec(result).isNegative()) throw new ToolError('INVALID_PRICING', 'Missing or invalid price in catalog');
    return dec(result);
  };
  function lookup(modelId, version, mode) {
    const model = catalog.models.find(m => m.KEY === modelId && visible(m, mode));
    if (!model) throw new ToolError('MODEL_NOT_FOUND', `Unknown model for ${mode}: ${modelId}`);
    const price = model.VERSION.find(v => v.NAME === version);
    if (!price) throw new ToolError('VERSION_NOT_FOUND', `Unknown version ${version} for ${modelId}`);
    return {model, price};
  }
  function pricingModes(model, price) {
    const modes = ['Standard'];
    if (modelType(model) === 'text-gen') {
      if (price.READ_CACHED_INPUT_TOKENS > 0 || price.WRITE_CACHED_INPUT_TOKENS > 0 || price.CACHE_WRITE_5M_TTL_INPUT_TOKENS > 0 || price.CACHE_WRITE_1H_TTL_INPUT_TOKENS > 0) modes.push('Cached');
      if (rules.batch.modelIds.includes(model.KEY)) modes.push('Batch');
    }
    return modes;
  }
  function usageSpec(model, price, pricingMode) {
    const type = modelType(model);
    const required = [...baseFields[type]];
    const optional = [];
    if (pricingMode === 'Cached') optional.push('readCachedInputTokensPerRequest', 'writeCachedInputTokensPerRequest');
    if (type === 'realtime') optional.push('cachedAudioTokensPerRequest');
    if (type === 'multimodal-embedding') {
      for (const [key, rate] of [['inputImageTokensPerRequest', 'INPUT_IMAGE_TOKENS'], ['inputAudioTokensPerRequest', 'INPUT_AUDIO_TOKENS'], ['inputVideoTokensPerRequest', 'INPUT_VIDEO_TOKENS']]) {
        if (price[rate] > 0) optional.push(key);
      }
    }
    return {required, optional};
  }
  function checkUsage(item, model, price) {
    const spec = usageSpec(model, price, item.pricingMode);
    for (const key of spec.required) if (item.usage[key] === undefined) fail(`${item.modelId}: usage.${key} is required`);
    for (const key of Object.keys(item.usage)) if (![...spec.required, ...spec.optional].includes(key)) fail(`${item.modelId}: usage.${key} is not applicable`);
    if (item.cacheDuration && item.pricingMode !== 'Cached') fail('cacheDuration requires Cached mode');
    if (item.searchEffort && !price.SEARCH_EFFORT) fail('searchEffort is not supported by this version');
    if (item.cacheDuration === '1h' && !(price.CACHE_WRITE_1H_TTL_INPUT_TOKENS > 0)) fail('1h cache write pricing is not supported');
    if (item.pricingMode === 'Cached') {
      if (item.usage.readCachedInputTokensPerRequest > 0 && !(price.READ_CACHED_INPUT_TOKENS > 0)) fail('Cached read tokens are not supported');
      if (item.usage.writeCachedInputTokensPerRequest > 0 && !((price.CACHE_WRITE_5M_TTL_INPUT_TOKENS ?? price.WRITE_CACHED_INPUT_TOKENS) > 0 || item.cacheDuration === '1h' && price.CACHE_WRITE_1H_TTL_INPUT_TOKENS > 0)) fail('Cached write tokens are not supported');
    }
  }
  function foundation(item, mode) {
    const {model, price} = lookup(item.modelId, item.version, mode);
    if (!pricingModes(model, price).includes(item.pricingMode)) fail(`${item.pricingMode} is not supported for ${item.modelId}/${item.version}`);
    checkUsage(item, model, price);
    const u = item.usage;
    const k = dec(catalog.constants.CAPACITY_UNITS_PER_TOKEN);
    const token = (field, rate) => dec(u[field] ?? 0).div(1000).times(price[rate] ?? 0);
    let cost;
    switch (modelType(model)) {
      case 'text-gen': {
        let perRequest = token('inputTokensPerRequest', 'INPUT_TOKENS').plus(token('outputTokensPerRequest', 'OUTPUT_TOKENS'));
        if (item.pricingMode === 'Batch') perRequest = perRequest.times(rules.batch.multiplier);
        if (item.pricingMode === 'Cached') {
          const write = item.cacheDuration === '1h' ? price.CACHE_WRITE_1H_TTL_INPUT_TOKENS : price.CACHE_WRITE_5M_TTL_INPUT_TOKENS ?? price.WRITE_CACHED_INPUT_TOKENS ?? 0;
          perRequest = perRequest.plus(token('readCachedInputTokensPerRequest', 'READ_CACHED_INPUT_TOKENS')).plus(dec(u.writeCachedInputTokensPerRequest ?? 0).div(1000).times(write));
        }
        const searchCharge = price.API_CALLS_PRICING?.[item.searchEffort ?? 'low'] ?? 0;
        cost = perRequest.plus(searchCharge).times(u.requestsPerMonth).times(k);
        break;
      }
      case 'embedding': cost = token('inputTokensPerRequest', 'INPUT_TOKENS').times(u.requestsPerMonth).times(k); break;
      case 'multimodal-embedding':
        cost = sum([token('inputTokensPerRequest', 'INPUT_TOKENS'), token('inputImageTokensPerRequest', 'INPUT_IMAGE_TOKENS'), token('inputAudioTokensPerRequest', 'INPUT_AUDIO_TOKENS'), token('inputVideoTokensPerRequest', 'INPUT_VIDEO_TOKENS')]).times(u.requestsPerMonth).times(k); break;
      case 'realtime':
        cost = sum([token('inputTextTokensPerRequest', 'INPUT_TOKENS'), token('outputTextTokensPerRequest', 'OUTPUT_TOKENS'), token('inputAudioTokensPerRequest', 'INPUT_AUDIO_TOKENS'), token('outputAudioTokensPerRequest', 'OUTPUT_AUDIO_TOKENS'), token('cachedAudioTokensPerRequest', 'INPUT_CACHED_AUDIO_TOKENS')]).times(u.requestsPerMonth).times(k); break;
      case 'image-gen':
        cost = sum([token('inputTokensPerRequest', 'INPUT_TOKENS'), token('outputTokensPerRequest', 'OUTPUT_TOKENS'), token('inputImageTokensPerRequest', 'INPUT_IMAGE_TOKENS'), token('outputImageTokensPerRequest', 'OUTPUT_IMAGE_TOKENS')]).times(u.requestsPerMonth).times(k); break;
      case 'reranker': cost = dec(u.queriesPerMonth).div(1000).times(price.SEARCH_UNITS).times(k); break;
      case 'tabular': cost = dec(u.contextCellsPerPrediction).times(price.NUM_INPUT_CELLS).plus(dec(u.predictedCellsPerPrediction).times(price.NUM_PREDICTION)).times(u.predictionsPerMonth).times(k); break;
    }
    const warnings = [];
    if (price.DEPRECATED) warnings.push('MODEL_DEPRECATED');
    if (price.RETIREMENT_DATE && price.RETIREMENT_DATE <= now().toISOString().slice(0, 10)) warnings.push('MODEL_RETIREMENT_DATE_PASSED');
    return {cost, model, price, warnings};
  }
  function requireFields(object, keys, name) {
    for (const key of keys) if (object[key] === undefined) fail(`${name}.${key} is required when enabled`);
  }
  function estimate(args) {
    const mode = args.mode ?? 'external';
    const lines = [];
    const warnings = [];
    const add = (category, label, amount, detail = {}) => lines.push({category, label, amount, ...detail});
    for (const item of args.foundationModels ?? []) {
      const result = foundation(item, mode);
      add('foundationModels', item.modelId, result.cost, {modelId: item.modelId, version: item.version, pricingMode: item.pricingMode, usage: item.usage, appliedPrices: result.price});
      warnings.push(...result.warnings.map(code => ({code, modelId: item.modelId, version: item.version})));
    }
    const o = args.orchestration;
    if (o?.enabled) {
      const k = dec(catalog.constants.CAPACITY_UNITS_PER_TOKEN);
      const rate = key => unitPrice(catalog.orchestration[key], mode);
      if (o.contentFilter?.enabled) {
        requireFields(o.contentFilter, ['blocksPerMonth'], 'orchestration.contentFilter');
        add('orchestration', 'contentFilter', dec(o.contentFilter.blocksPerMonth).times(rate('contentFilter')).times(k));
      }
      if (o.grounding?.enabled) {
        requireFields(o.grounding, ['queriesPerMonth', 'storageGBDay'], 'orchestration.grounding');
        add('orchestration', 'groundingQueries', dec(o.grounding.queriesPerMonth).times(rules.orchestration.groundingBlocksPerQuery).times(rate('grounding')).times(k));
        add('orchestration', 'groundingStorage', dec(o.grounding.storageGBDay).times(rate('groundingStorage')));
      }
      for (const key of ['translation', 'dataMasking', 'inferenceObservability']) {
        if (!o[key]?.enabled) continue;
        requireFields(o[key], ['requestsPerMonth'], `orchestration.${key}`);
        let cost = dec(o[key].requestsPerMonth).times(rate(key));
        if (key === 'translation') cost = cost.times(catalog.orchestration.translationBlocksPerCall);
        if (key !== 'inferenceObservability') cost = cost.times(k);
        add('orchestration', key, cost);
      }
    }
    if (args.promptOptimization?.enabled) {
      requireFields(args.promptOptimization, ['promptsPerMonth'], 'promptOptimization');
      add('promptOptimization', 'prompts', dec(args.promptOptimization.promptsPerMonth).times(rules.promptOptimizationCUPerPrompt));
    }
    if (args.evaluation?.enabled) {
      requireFields(args.evaluation, ['nodeHoursPerMonth'], 'evaluation');
      add('evaluation', 'nodeHours', dec(args.evaluation.nodeHoursPerMonth).times(rules.evaluationCUPerNodeHour));
    }
    if (args.compute?.enabled) {
      let nodeHours = zero();
      for (const item of args.compute.instances ?? []) {
        const instance = catalog.instances.find(i => `${i.cloud.toUpperCase()}:${i.name}` === item.instanceKey && visible(i, mode));
        if (!instance) throw new ToolError('INSTANCE_NOT_FOUND', `Unknown instance for ${mode}: ${item.instanceKey}`);
        const hours = dec(item.hoursPerMonth).times(item.replicas);
        nodeHours = nodeHours.plus(hours);
        add('computeInstances', item.instanceKey, unitPrice(instance.pricePerHour, mode).times(hours), {usage: item, cuPerHour: unitPrice(instance.pricePerHour, mode).toFixed()});
        if (item.storageGB > 0) add('computeStorage', `${item.instanceKey}:attachedStorage`, unitPrice(catalog.storage.pricePerHour, mode).times(item.storageGB).times(item.hoursPerMonth));
      }
      if (args.compute.instances?.length) add('computeBaseline', 'baseline', unitPrice(catalog.baseline.pricePerHour, mode).times(D.min(nodeHours, rules.computeBaselineHourCap)));
      if (args.compute.objectStorage?.enabled) {
        requireFields(args.compute.objectStorage, ['storageGB'], 'compute.objectStorage');
        add('computeStorage', 'objectStorage', unitPrice(catalog.storage.pricePerHour, mode).times(args.compute.objectStorage.storageGB).times(catalog.constants.HOURS_PER_MONTH));
      }
    }
    const total = sum(lines.map(l => l.amount));
    const breakdown = Object.fromEntries([...new Set(lines.map(l => l.category))].map(category => [category, formatted(sum(lines.filter(l => l.category === category).map(l => l.amount)))]));
    let currency = null;
    if (args.currency) currency = {code: args.currency.code, amount: formatted(total.times(args.currency.ratePerCU)), basis: 'user-supplied-contract-rate', ratePerCU: args.currency.ratePerCU};
    else if (mode === 'internal') {
      const c = rules.internalCurrency;
      currency = {code: c.code, amount: formatted(sum(lines.map(l => l.amount.times(c.cuRate).times(l.category.startsWith('compute') ? c.computeMultiplier : c.generativeMultiplier)))), basis: 'SAP-internal-charge-rate'};
    }
    return {
      ...metadata(), mode, monthlyCU: Number(formatted(total)), monthlyCUExact: formatted(total), breakdown, currency,
      lineItems: lines.map(({amount, ...line}) => ({...line, monthlyCUExact: formatted(amount)})), warnings,
      assumptions: ['Optional services are enabled explicitly; UI auto-recommendations are not applied.', 'Pricing is an estimate, not an SAP quote.', 'Grounding storageGBDay follows the source formula without an additional day multiplier.']
    };
  }
  return {
    list_models({query = '', provider, mode = 'external'} = {}) {
      return {...metadata(), mode, models: catalog.models.filter(m => visible(m, mode) && (!provider || m.PROVIDER.toLowerCase() === provider.toLowerCase()) && `${m.KEY} ${m.NAME} ${m.DISPLAY_NAME}`.toLowerCase().includes(query.toLowerCase())).map(m => ({modelId: m.KEY, name: m.DISPLAY_NAME.trim(), provider: m.PROVIDER, modelType: modelType(m), versions: m.VERSION.map(v => ({version: v.NAME, isLatest: v.IS_LATEST, deprecated: v.DEPRECATED, retirementDate: v.RETIREMENT_DATE}))}))};
    },
    get_model_pricing({modelId, version, mode = 'external'}) {
      const {model, price} = lookup(modelId, version, mode);
      const modes = pricingModes(model, price);
      return {...metadata(), modelId, version, mode, modelType: modelType(model), pricingModes: modes, prices: price, cuMultiplier: catalog.constants.CAPACITY_UNITS_PER_TOKEN, tokenPriceUnit: 'per-1000-tokens-before-CU-multiplier', usageByMode: Object.fromEntries(modes.map(m => [m, usageSpec(model, price, m)]))};
    },
    list_compute_instances({query = '', mode = 'external'} = {}) {
      return {...metadata(), mode, instances: catalog.instances.filter(i => visible(i, mode) && `${i.cloud}:${i.name}`.toLowerCase().includes(query.toLowerCase())).map(i => ({instanceKey: `${i.cloud.toUpperCase()}:${i.name}`, description: i.description, cuPerHour: unitPrice(i.pricePerHour, mode).toFixed()}))};
    },
    estimate_ai_core_cost: estimate
  };
}
