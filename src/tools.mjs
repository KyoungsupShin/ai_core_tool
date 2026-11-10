import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { createEngine, ToolError } from './engine.mjs';
import { schemas, toolDefinitions } from './schemas.mjs';

export { toolDefinitions, ToolError };
const read = name => JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
export function createTools({catalog = read('catalog'), rules = read('rules'), now} = {}) {
  const ajv = new Ajv({allErrors: true, strict: true});
  const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));
  // Isolate each tool instance from later mutation of caller-owned configuration.
  const engine = createEngine(structuredClone(catalog), structuredClone(rules), {now});
  function callTool(name, args = {}) {
    if (!Object.hasOwn(validators, name)) throw new ToolError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    if (!validators[name](args)) throw new ToolError('INVALID_ARGUMENT', 'Input schema validation failed', structuredClone(validators[name].errors));
    return structuredClone(engine[name](args));
  }
  return {definitions: structuredClone(toolDefinitions), callTool};
}
