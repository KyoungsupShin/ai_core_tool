import { readFileSync } from 'node:fs';
import { createTools, toolDefinitions } from './tools.mjs';

try {
  const [name, json] = process.argv.slice(2);
  if (!name || name === '--help') {
    console.log('Usage: node src/cli.mjs <tool-name> [JSON | @file.json]\n       node src/cli.mjs --definitions\n       node src/cli.mjs --call < request.json');
  } else if (name === '--definitions') console.log(JSON.stringify(toolDefinitions, null, 2));
  else {
    const readArgument = value => value?.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value ?? (process.stdin.isTTY ? '{}' : readFileSync(0, 'utf8') || '{}');
    const request = JSON.parse(readArgument(json));
    if (name === '--call' && (!request || typeof request.name !== 'string' || !request.arguments)) throw Error('Expected {name, arguments}');
    const result = createTools().callTool(name === '--call' ? request.name : name, name === '--call' ? request.arguments : request);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({error: {code: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details ? {details: error.details} : {})}}, null, 2));
  process.exitCode = 1;
}
