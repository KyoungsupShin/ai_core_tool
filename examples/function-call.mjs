import { createTools } from '../src/tools.mjs';
import { readFileSync } from 'node:fs';

const {callTool, definitions} = createTools();
const input = JSON.parse(readFileSync(new URL('./estimate.json', import.meta.url), 'utf8'));
console.log(JSON.stringify(callTool('estimate_ai_core_cost', input), null, 2));
// Pass `definitions` as the tool list for a function-calling agent.
// Dispatch each returned function name and parsed arguments to callTool.
void definitions;
