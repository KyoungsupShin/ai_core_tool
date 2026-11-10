import {createHash} from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

function fields(a, b, path = '') {
  if (equal(a, b)) return [];
  if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(v => v && typeof v.NAME === 'string')) {
    return fields(Object.fromEntries(a.map(v => [v.NAME, v])), Object.fromEntries(b.map(v => [v.NAME, v])), path);
  }
  if (a && b && !Array.isArray(a) && !Array.isArray(b) && typeof a === 'object' && typeof b === 'object') {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => fields(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return [{path, before: a ?? null, after: b ?? null}];
}

export function compareSnapshots(active, candidate) {
  const compare = (a, b, key) => {
    const previous = new Map(a.map(v => [key(v), v]));
    const next = new Map(b.map(v => [key(v), v]));
    return {
      added: [...next.keys()].filter(k => !previous.has(k)),
      removed: [...previous.keys()].filter(k => !next.has(k)),
      changed: [...next.keys()].filter(k => previous.has(k) && !equal(previous.get(k), next.get(k))),
      details: [...next.keys()].filter(k => previous.has(k) && !equal(previous.get(k), next.get(k))).map(k => ({key: k, changes: fields(previous.get(k), next.get(k))})),
    };
  };
  const sections = ['constants', 'orchestration', 'storage', 'baseline'];
  const models = compare(active.models, candidate.models, m => m.KEY);
  const instances = compare(active.instances, candidate.instances, m => `${m.cloud}:${m.name}`);
  const changedSections = sections.filter(k => !equal(active[k], candidate[k]));
  const sourceChanged = active.pricingVersion !== candidate.pricingVersion;
  const dataChanged = changedSections.length > 0 || [models, instances].some(d => d.added.length || d.removed.length || d.changed.length);
  return {previousVersion: active.pricingVersion, candidateVersion: candidate.pricingVersion, sourceChanged, dataChanged,
    sourceOnlyChanged: sourceChanged && !dataChanged, models, instances, changedSections,
    sectionDetails: changedSections.flatMap(k => fields(active[k], candidate[k], k)),
    policyReviewRequired: sourceChanged,
    note: 'Source changes may include calculation-rule changes. Review rules.json and source parity fixtures before merging a pricing update.'};
}

export function markdownReport(report) {
  const d = report.diff;
  const json = value => JSON.stringify(value).replaceAll('`', '\\`').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = [...d.models.details.flatMap(m => m.changes.map(c => ({...c, path: `models.${m.key}.${c.path}`}))),
    ...d.instances.details.flatMap(m => m.changes.map(c => ({...c, path: `instances.${m.key}.${c.path}`}))), ...d.sectionDetails];
  return [
    '# SAP AI Core Pricing Update', '',
    `Checked: ${report.checkedAt}`, `Source: ${report.site}`, `Bundle: ${report.bundleUrl}`, '',
    `Previous source SHA: \`${d.previousVersion}\``, `Candidate source SHA: \`${d.candidateVersion}\``, '',
    `Source changed: **${d.sourceChanged}**; pricing data changed: **${d.dataChanged}**.`,
    `Models: +${d.models.added.length} / -${d.models.removed.length} / changed ${d.models.changed.length}.`,
    `Instances: +${d.instances.added.length} / -${d.instances.removed.length} / changed ${d.instances.changed.length}.`,
    `Changed sections: ${d.changedSections.join(', ') || 'none'}.`,
    `Validation: ${report.validation.checkedCases} model/version/mode cases passed.`, '',
    '## Review', '',
    '- This is a draft pricing update. No automatic merge is configured.',
    '- Check calculation rules in the downloaded source; bundle changes can include more than prices.',
    '- Revalidate historical browser parity fixtures and example estimates when prices or supported models change.',
    '- Full before/after values, downloaded HTML and bundle are in the workflow artifact.', '',
    '## Changes', '', '| Path | Before | After |', '| --- | --- | --- |',
    ...rows.slice(0, 40).map(c => `| ${json(c.path)} | ${json(c.before).slice(0, 150)} | ${json(c.after).slice(0, 150)} |`), '',
    rows.length > 40 ? `${rows.length - 40} additional field changes are in report.json.` : '',
    `Added model IDs: ${json(d.models.added)}.`, `Removed model IDs: ${json(d.models.removed)}.`, '',
  ].join('\n');
}
