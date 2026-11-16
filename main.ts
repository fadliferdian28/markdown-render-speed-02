// Driver for the Markdash renderer. The harness runs `node /bot/main.ts`: it
// reads every case from cases.json, renders each one alone with parse(), and
// writes the HTML strings, in order, to html.json. Outside a container the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR variables stand in for /input /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
) as { id: string; markdown: string }[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
