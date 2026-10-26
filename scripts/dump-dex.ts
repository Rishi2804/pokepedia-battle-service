/**
 * Dumps Showdown's species, moves and abilities as JSON, three files in the
 * directory given. The api-v2 scraper (cmd/scrape) joins them onto PokePedia's
 * pokemon, move and ability rows to set `showdown_id` and, for species, the
 * battle-only base and required item, so the team builder and this server
 * stop keeping hand-copied slug tables.
 *
 * Battle-only formes (Mega, Primal, Crowned, Gmax, ...) are resolved with the
 * same function the team converter uses (resolveBattleOnly), so what is stored
 * is exactly what a battle would do with that forme.
 *
 * Usage: npm run dumpdex -- <out-dir>
 *        npm run dumpdex -- ../pokepedia-api-v2/cmd/scrape/data
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Dex } from '@pkmn/sim';
import { resolveBattleOnly } from '../src/teamConvert.js';

const outDir = process.argv[2];
if (!outDir) {
	console.error('usage: npm run dumpdex -- <out-dir>');
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

const species = Dex.species.all().map(s => {
	const resolved = resolveBattleOnly(s);
	const battleOnly = !!resolved && resolved.species.id !== s.id;
	return {
		id: s.id,
		name: s.name,
		num: s.num,
		baseSpecies: s.baseSpecies,
		forme: s.forme,
		isNonstandard: s.isNonstandard ?? null,
		// The species a team submits for this forme, and what reaches it.
		battleOnlyBaseId: battleOnly ? resolved!.species.id : null,
		requiredItemIds: [...new Set([s.requiredItem, ...(s.requiredItems ?? [])].filter(Boolean).map(i => Dex.items.get(i!).id))],
		gigantamax: resolved?.gigantamax ?? false,
	};
}).sort(byId);

const moves = Dex.moves.all().map(m => ({
	id: m.id,
	name: m.name,
	num: m.num,
	isNonstandard: m.isNonstandard ?? null,
})).sort(byId);

const abilities = Dex.abilities.all().map(a => ({
	id: a.id,
	name: a.name,
	num: a.num,
	isNonstandard: a.isNonstandard ?? null,
})).sort(byId);

const write = (file: string, rows: unknown[]) =>
	writeFileSync(join(outDir, file), JSON.stringify(rows, null, '\t') + '\n');
write('showdown-species.json', species);
write('showdown-moves.json', moves);
write('showdown-abilities.json', abilities);
console.error(`${species.length} species, ${moves.length} moves, ${abilities.length} abilities -> ${outDir}`);
