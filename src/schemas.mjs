const count = {type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER};
const quantity = {type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER};
const text = {type: 'string', minLength: 1, maxLength: 200};
const object = (properties, required = []) => ({type: 'object', additionalProperties: false, properties, required});
const mode = {enum: ['external', 'internal']};
export const usageFields = [
  'inputTokensPerRequest', 'outputTokensPerRequest', 'requestsPerMonth',
  'readCachedInputTokensPerRequest', 'writeCachedInputTokensPerRequest',
  'inputTextTokensPerRequest', 'outputTextTokensPerRequest',
  'inputAudioTokensPerRequest', 'outputAudioTokensPerRequest', 'cachedAudioTokensPerRequest',
  'inputImageTokensPerRequest', 'outputImageTokensPerRequest', 'inputVideoTokensPerRequest',
  'queriesPerMonth', 'contextCellsPerPrediction', 'predictedCellsPerPrediction', 'predictionsPerMonth'
];
const usage = object(Object.fromEntries(usageFields.map(key => [key, count])));
const enabled = {type: 'boolean'};
const toggle = (properties) => object({enabled, ...properties}, ['enabled']);
export const schemas = {
  list_models: object({query: text, provider: text, mode}),
  get_model_pricing: object({modelId: text, version: text, mode}, ['modelId', 'version']),
  list_compute_instances: object({query: text, mode}),
  estimate_ai_core_cost: object({
    mode,
    foundationModels: {type: 'array', maxItems: 100, items: object({
      modelId: text, version: text, pricingMode: {enum: ['Standard', 'Cached', 'Batch']},
      cacheDuration: {enum: ['5min', '1h']}, searchEffort: {enum: ['low', 'medium', 'high']}, usage
    }, ['modelId', 'version', 'pricingMode', 'usage'])},
    orchestration: toggle({
      contentFilter: toggle({blocksPerMonth: count}),
      grounding: toggle({queriesPerMonth: count, storageGBDay: quantity}),
      translation: toggle({requestsPerMonth: count}),
      dataMasking: toggle({requestsPerMonth: count}),
      inferenceObservability: toggle({requestsPerMonth: count})
    }),
    promptOptimization: toggle({promptsPerMonth: count}),
    evaluation: toggle({nodeHoursPerMonth: quantity}),
    compute: toggle({
      instances: {type: 'array', maxItems: 100, items: object({
        instanceKey: text, hoursPerMonth: quantity,
        replicas: {type: 'integer', minimum: 1, maximum: 1000000}, storageGB: quantity
      }, ['instanceKey', 'hoursPerMonth', 'replicas'])},
      objectStorage: toggle({storageGB: quantity})
    }),
    currency: object({code: {type: 'string', pattern: '^[A-Z]{3}$'}, ratePerCU: {type: 'number', exclusiveMinimum: 0, maximum: 1000000000}}, ['code', 'ratePerCU'])
  })
};

const descriptions = {
  list_models: 'List SAP AI Core pricing models and original version names. Default mode: external.',
  get_model_pricing: 'Return version-specific raw token prices, supported pricing modes and required usage fields. Token prices are per 1000 tokens before the CU multiplier.',
  list_compute_instances: 'List compute instance keys and CU per hour, including SAP resource plans.',
  estimate_ai_core_cost: 'Estimate monthly SAP AI Core CU from an explicit configuration. Token fields are per request; requests are monthly. Optional services are disabled unless enabled explicitly. Returns exact decimal strings, line items and pricing/rule versions. External currency requires a contract ratePerCU.'
};
export const toolDefinitions = Object.entries(schemas).map(([name, parameters]) => ({type: 'function', function: {name, description: descriptions[name], parameters}}));
