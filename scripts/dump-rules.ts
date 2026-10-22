/**
 * Writes the per-game rules (src/versionRules.ts) as JSON, so the team builder
 * reads the same table this server converts teams with instead of keeping its
 * own copy of it. Same idea as dump-items.ts and dump-dex.ts: the battle
 * server owns the data, the other projects consume a generated file.
 *
 * Usage: npm run dumprules -- <out.json>
 *        npm run dumprules -- ../pokepedia-ui/src/global/data/battleRules.json
 */
import { writeFileSync } from 'node:fs';
import { allGameRules } from '../src/versionRules.js';

const dest = process.argv[2];
if (!dest) {
	console.error('usage: npm run dumprules -- <out.json>');
	process.exit(1);
}

const rules = allGameRules();
writeFileSync(dest, JSON.stringify(rules, null, '\t') + '\n');
console.error(`${Object.keys(rules.versionGroups).length} version groups + home -> ${dest}`);
