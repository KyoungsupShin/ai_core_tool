import {appendFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {refreshPricing, activatePricing} from './pricing/pipeline.mjs';

try {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {output: {type: 'string'}, run: {type: 'string'}, 'expected-sha': {type: 'string'}}});
  const command = positionals[0] || 'refresh';
  if (!['refresh', 'activate'].includes(command) || positionals.length > 1) throw Error('Use refresh [--output DIR] or activate --run DIR --expected-sha SHA.');
  const result = command === 'activate'
    ? await activatePricing({run: values.run, expectedSHA: values['expected-sha']})
    : await refreshPricing({output: values.output});
  if (process.env.GITHUB_OUTPUT && command === 'refresh') await appendFile(process.env.GITHUB_OUTPUT, `changed=${result.changed}\nsha=${result.sourceSHA}\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({error: error.message})); process.exitCode = 1; }
