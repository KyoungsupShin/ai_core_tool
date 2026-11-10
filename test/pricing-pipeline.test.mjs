import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverBundle, download, refreshPricing, activatePricing, SITE} from '../scripts/pricing/pipeline.mjs';
import {compareSnapshots, digest} from '../scripts/pricing/diff.mjs';
import {validateCandidate} from '../scripts/pricing/validate.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url)));
const rules = JSON.parse(await readFile(new URL('../data/rules.json', import.meta.url)));
const sourceFor = c => [c.models, c.instances.filter(i => !i.icon), c.instances.filter(i => i.icon).map(({cloud, ...plan}) => plan),
  [c.storage], [c.baseline], c.constants, c.orchestration,
  Object.fromEntries(c.models.filter(m => m.availability !== 'both').map(m => [m.KEY, m.availability]))]
  .map((value, i) => `const data${i}=${JSON.stringify(value)};`).join('\n');
const html = '<script type="module" src="/assets/new-build.js"></script>';
const fakeFetch = source => async url => new Response(url === SITE ? html : source, {status: 200});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pricing-pipeline-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/catalog.json'), JSON.stringify(catalog));
  await writeFile(join(root, 'data/rules.json'), JSON.stringify(rules));
  return root;
}

test('module discovery parses HTML and rejects ambiguous/external entry points', () => {
  assert.equal(discoverBundle('<script src="ignored.js"></script><script src="/assets/hash.js?a=1&amp;b=2" type="module"></script>'), `${SITE}assets/hash.js?a=1&b=2`);
  assert.throws(() => discoverBundle('<script type="module" src="https://example.org/script.js"></script>'), /Untrusted/);
  assert.throws(() => discoverBundle(html + html), /Expected one/);
});
test('HTTP errors, cross-origin redirects and oversized responses fail', async () => {
  await assert.rejects(download(SITE, {fetchImpl: async () => new Response('', {status: 503})}), /503/);
  await assert.rejects(download(SITE, {fetchImpl: async () => new Response('', {status: 302, headers: {location: 'https://example.org'}})}), /Untrusted/);
  await assert.rejects(download(SITE, {maxBytes: 2, fetchImpl: async () => new Response('too large')}), /too large/);
});
test('refresh discovers new hashes and stages candidate without changing active pricing', async t => {
  const root = await fixture(t);
  const before = await readFile(join(root, 'data/catalog.json'), 'utf8');
  const c = structuredClone(catalog); c.models[0].VERSION[0].INPUT_TOKENS *= 2;
  const result = await refreshPricing({root, fetchImpl: fakeFetch(sourceFor(c))});
  assert.equal(await readFile(join(root, 'data/catalog.json'), 'utf8'), before);
  assert.equal(result.report.diff.dataChanged, true);
  assert.ok(result.report.validation.checkedCases > 100);
  assert.equal(result.report.diff.models.changed[0], c.models[0].KEY);
  assert.ok(result.report.diff.models.details[0].changes.some(change => change.path.endsWith('.INPUT_TOKENS')));
  assert.ok((await readFile(join(result.run, 'report.md'), 'utf8')).includes('Review'));
});
test('no-change and source-only changes are distinguished', () => {
  const same = structuredClone(catalog); same.source.capturedAt = 'different-metadata';
  assert.equal(compareSnapshots(catalog, same).dataChanged, false);
  assert.equal(compareSnapshots(catalog, same).sourceChanged, false);
  same.pricingVersion = 'f'.repeat(64);
  assert.equal(compareSnapshots(catalog, same).sourceOnlyChanged, true);
});
test('invalid extracted pricing produces failure evidence but no active/candidate replacement', async t => {
  const root = await fixture(t);
  const bad = structuredClone(catalog); bad.models[0].VERSION[0].INPUT_TOKENS = -1;
  const output = join(root, 'failure-run');
  await assert.rejects(refreshPricing({root, output, fetchImpl: fakeFetch(sourceFor(bad))}), /Invalid pricing/);
  assert.equal(digest(JSON.parse(await readFile(join(root, 'data/catalog.json')))), digest(catalog));
  assert.ok(JSON.parse(await readFile(join(output, 'failure.json'))).error);
  await assert.rejects(readFile(join(output, 'candidate.json')), /ENOENT/);
});
test('candidate shape, rates and duplicate IDs are validated', () => {
  const bad = structuredClone(catalog); bad.models.push(bad.models[0]);
  assert.throws(() => validateCandidate(bad, rules), /duplicate/);
  const missing = structuredClone(catalog); delete missing.models[0].VERSION[0].INPUT_TOKENS;
  assert.throws(() => validateCandidate(missing, rules), /Invalid pricing/);
});
test('activation requires a reviewed SHA and preserves previous active pricing', async t => {
  const root = await fixture(t);
  const result = await refreshPricing({root, fetchImpl: fakeFetch(sourceFor(catalog))});
  await assert.rejects(activatePricing({root, run: result.run}), /expected-sha/);
  await assert.rejects(activatePricing({root, run: result.run, expectedSHA: '0'.repeat(64)}), /does not match/);
  const activated = await activatePricing({root, run: result.run, expectedSHA: result.sourceSHA});
  assert.equal(activated.activated, true);
  assert.equal(digest(JSON.parse(await readFile(activated.previousCatalog))), digest(catalog));
  assert.equal(JSON.parse(await readFile(join(root, 'data/catalog.json'))).pricingVersion, result.sourceSHA);
  assert.equal((await activatePricing({root, run: result.run, expectedSHA: result.sourceSHA})).reason, 'already-active');
});
test('tampered candidates and stale active catalogs cannot be activated', async t => {
  const root = await fixture(t);
  const result = await refreshPricing({root, fetchImpl: fakeFetch(sourceFor(catalog))});
  const path = join(result.run, 'candidate.json');
  const original = await readFile(path, 'utf8');
  const changed = JSON.parse(original); changed.constants.HOURS_PER_MONTH = 1;
  await writeFile(path, JSON.stringify(changed));
  await assert.rejects(activatePricing({root, run: result.run, expectedSHA: result.sourceSHA}), /changed since validation/);
  await writeFile(path, original);
  const stale = structuredClone(catalog); stale.constants.HOURS_PER_MONTH = 720;
  await writeFile(join(root, 'data/catalog.json'), JSON.stringify(stale));
  await assert.rejects(activatePricing({root, run: result.run, expectedSHA: result.sourceSHA}), /stale activation/);
  await assert.rejects(readFile(join(root, 'data/.pricing-update.lock')), /ENOENT/);
});
