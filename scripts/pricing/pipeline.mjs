import {parse} from 'parse5';
import {fetch, EnvHttpProxyAgent} from 'undici';
import {mkdir, mkdtemp, readFile, writeFile, rename, unlink, open} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {extractSnapshot} from '../import-snapshot.mjs';
import {compareSnapshots, digest, markdownReport} from './diff.mjs';
import {validateCandidate} from './validate.mjs';

export const SITE = 'https://ai-core-calculator.cfapps.eu10.hana.ondemand.com/';
const json = value => JSON.stringify(value, null, 2) + '\n';
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));

function trusted(url) {
  const value = new URL(url);
  if (value.origin !== new URL(SITE).origin || value.username || value.password) throw Error(`Untrusted pricing URL: ${value.origin}`);
  return value.href;
}

export function discoverBundle(html) {
  const scripts = [];
  const walk = node => {
    const attrs = Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
    if (node.tagName === 'script' && attrs.type === 'module' && attrs.src) scripts.push(trusted(new URL(attrs.src, SITE)));
    for (const child of node.childNodes || []) walk(child);
  };
  walk(parse(html));
  if (scripts.length !== 1) throw Error(`Expected one entry module, found ${scripts.length}; inspect site changes.`);
  return scripts[0];
}

export async function download(url, {fetchImpl = fetch, dispatcher, maxBytes = 8 * 1024 * 1024} = {}) {
  let current = trusted(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchImpl(current, {redirect: 'manual', signal: AbortSignal.timeout(30000), ...(dispatcher ? {dispatcher} : {}), headers: {'Cache-Control': 'no-cache'}});
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw Error('Redirect without a location');
      current = trusted(new URL(location, current));
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw Error(`Pricing download HTTP ${response.status}`); }
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw Error('Pricing download is too large'); }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw Error('Pricing download is too large');
      chunks.push(chunk);
    }
    return {text: Buffer.concat(chunks).toString('utf8'), url: current, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified')};
  }
  throw Error('Too many pricing redirects');
}

export async function refreshPricing({root = process.cwd(), output, fetchImpl} = {}) {
  root = resolve(root);
  const parent = join(root, 'work', 'pricing-refresh');
  await mkdir(parent, {recursive: true});
  let run;
  if (output) { run = resolve(output); await mkdir(dirname(run), {recursive: true}); await mkdir(run); }
  else run = await mkdtemp(join(parent, 'run-'));
  const active = await readJSON(join(root, 'data/catalog.json'));
  const rules = await readJSON(join(root, 'data/rules.json'));
  const dispatcher = fetchImpl ? undefined : new EnvHttpProxyAgent();
  try {
    const html = await download(SITE, {fetchImpl, dispatcher, maxBytes: 1024 * 1024});
    await writeFile(join(run, 'source.html'), html.text, {flag: 'wx'});
    const bundle = await download(discoverBundle(html.text), {fetchImpl, dispatcher});
    await writeFile(join(run, 'source.js'), bundle.text, {flag: 'wx'});
    const candidate = extractSnapshot(bundle.text, bundle.url);
    const validation = validateCandidate(candidate, rules);
    const report = {schemaVersion: 1, checkedAt: new Date().toISOString(), site: SITE, bundleUrl: bundle.url,
      activeCatalogHash: digest(active), candidateHash: digest(candidate), rulesHash: digest(rules),
      source: {htmlETag: html.etag, bundleETag: bundle.etag, lastModified: bundle.lastModified},
      diff: compareSnapshots(active, candidate), validation};
    await writeFile(join(run, 'candidate.json'), json(candidate), {flag: 'wx'});
    await writeFile(join(run, 'report.json'), json(report), {flag: 'wx'});
    await writeFile(join(run, 'report.md'), markdownReport(report), {flag: 'wx'});
    return {run, changed: report.diff.sourceChanged || report.diff.dataChanged, sourceSHA: candidate.pricingVersion, report};
  } catch (error) {
    await writeFile(join(run, 'failure.json'), json({checkedAt: new Date().toISOString(), error: error.message}), {flag: 'wx'});
    throw error;
  } finally { await dispatcher?.close(); }
}

export async function activatePricing({root = process.cwd(), run, expectedSHA} = {}) {
  if (!run || !/^[a-f0-9]{64}$/.test(expectedSHA || '')) throw Error('A run directory and explicit --expected-sha are required.');
  root = resolve(root); run = resolve(run);
  const candidate = await readJSON(join(run, 'candidate.json'));
  const report = await readJSON(join(run, 'report.json'));
  const rules = await readJSON(join(root, 'data/rules.json'));
  const source = await readFile(join(run, 'source.js'), 'utf8');
  if (candidate.pricingVersion !== expectedSHA || digest(source) !== expectedSHA) throw Error('Reviewed source SHA does not match the candidate.');
  if (digest(candidate) !== report.candidateHash || digest(rules) !== report.rulesHash) throw Error('Candidate or rules changed since validation; refresh again.');
  const extracted = extractSnapshot(source, candidate.source.bundleUrl, candidate.source.capturedAt);
  if (digest(extracted) !== digest(candidate)) throw Error('Candidate does not match the downloaded source.');
  validateCandidate(candidate, rules);
  const lockPath = join(root, 'data/.pricing-update.lock');
  const lock = await open(lockPath, 'wx');
  const target = join(root, 'data/catalog.json');
  const temp = join(root, `data/.catalog-${randomUUID()}.tmp`);
  try {
    const active = await readJSON(target);
    if (digest(active) === digest(candidate)) return {activated: false, reason: 'already-active', sourceSHA: expectedSHA};
    if (digest(active) !== report.activeCatalogHash) throw Error('Active catalog changed since refresh; refusing a stale activation.');
    await writeFile(join(run, 'previous-active.json'), json(active), {flag: 'wx'});
    await writeFile(temp, json(candidate), {flag: 'wx'});
    await rename(temp, target);
    return {activated: true, sourceSHA: expectedSHA, previousCatalog: join(run, 'previous-active.json')};
  } finally { await unlink(temp).catch(() => {}); await lock.close(); await unlink(lockPath); }
}
