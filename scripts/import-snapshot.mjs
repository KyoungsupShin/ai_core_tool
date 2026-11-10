import { parse } from 'acorn';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Accept data literals only; never evaluate downloaded application code.
function literal(node) {
  if (node.type === 'Literal') return node.value;
  if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
  if (node.type === 'UnaryExpression') {
    const value = literal(node.argument);
    if (node.operator === '!') return !value;
    if (node.operator === '-' && typeof value === 'number') return -value;
  }
  if (node.type === 'ArrayExpression') return node.elements.map(literal);
  if (node.type === 'ObjectExpression') {
    const result = {};
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.computed || property.kind !== 'init') throw Error('Non-data property');
      const key = property.key.type === 'Identifier' ? property.key.name : literal(property.key);
      Object.defineProperty(result, key, {value: literal(property.value), enumerable: true});
    }
    return result;
  }
  throw Error(`Non-data expression: ${node.type}`);
}

export function extractSnapshot(source, bundleUrl, capturedAt = new Date().toISOString()) {
  const ast = parse(source, {ecmaVersion: 'latest', sourceType: 'module'});
  const objects = [];
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (!declaration.init || !['ObjectExpression', 'ArrayExpression'].includes(declaration.init.type)) continue;
      try { objects.push(literal(declaration.init)); } catch { /* UI expressions are not catalog data. */ }
    }
  }
  const select = (predicate, label) => {
    const matches = objects.filter(predicate);
    if (matches.length !== 1) throw Error(`Expected one ${label}, found ${matches.length}; review source changes.`);
    return matches[0];
  };
  const models = select(v => Array.isArray(v) && v.length && v.every(m => m.KEY && m.CATEGORY && Array.isArray(m.VERSION)), 'model catalog');
  const instances = select(v => Array.isArray(v) && v.length && v.every(m => m.cloud && m.pricePerHour), 'compute instances');
  const plans = select(v => Array.isArray(v) && v.length && v[0].name === 'Starter' && v[0].pricePerHour, 'resource plans');
  const storage = select(v => Array.isArray(v) && v[0]?.id === 'STANDARD' && v[0]?.pricePerHour, 'storage pricing');
  const baseline = select(v => Array.isArray(v) && v[0]?.id === 'BASELINE', 'baseline pricing');
  const constants = select(v => v && !Array.isArray(v) && v.CAPACITY_UNITS_PER_TOKEN && v.HOURS_PER_MONTH, 'CU constants');
  const orchestration = select(v => v && !Array.isArray(v) && v.contentFilter && v.translationBlocksPerCall, 'orchestration pricing');
  const availability = select(v => v && !Array.isArray(v) && v.gemini3proimage === 'internal' && v.abapcodestral === 'internal', 'model availability');
  if (new Set(models.map(m => m.KEY)).size !== models.length) throw Error('Duplicate model IDs');
  return {
    schemaVersion: 1,
    pricingVersion: createHash('sha256').update(source).digest('hex'),
    source: {site: 'https://ai-core-calculator.cfapps.eu10.hana.ondemand.com/', bundleUrl, capturedAt},
    constants, orchestration, storage: storage[0], baseline: baseline[0],
    models: models.map(m => ({...m, availability: availability[m.KEY] || 'both'})),
    instances: [...instances, ...plans.map(p => ({...p, cloud: 'SAP'}))]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [bundle, destination] = process.argv.slice(2);
  if (!bundle || !destination) {
    console.error('Usage: npm run snapshot -- bundle.js candidate.json');
    process.exitCode = 1;
  } else {
    const source = await readFile(bundle, 'utf8');
    const candidate = extractSnapshot(source, process.env.SOURCE_BUNDLE_URL || 'local-reviewed-bundle');
    // Exclusive creation prevents silently replacing an approved price table.
    await writeFile(destination, JSON.stringify(candidate, null, 2) + '\n', {flag: 'wx'});
    console.log(JSON.stringify({destination, models: candidate.models.length, instances: candidate.instances.length, pricingVersion: candidate.pricingVersion}));
  }
}
