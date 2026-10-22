/**
 * Checks HOME sprite id resolution (src/homeIds.ts + view.ts's spriteIdFor):
 * a stubbed candidate list covers the id mapping (by the API's showdownId) and the
 * lookup order (team's own entry, then HOME id, then dex number). Set
 * POKEPEDIA_API_URL (e.g. http://localhost:8080/api/v1) to also check the
 * live API.
 *
 * Usage: npm run homecheck
 */
import { loadHomeIds } from '../src/homeIds.js';
import { spriteIdFor } from '../src/view.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` - ${detail}`}`);
	if (!ok) failures++;
}

const stub = [{
	listName: 'National',
	pokemon: [
		{ id: 6, slug: 'charizard', showdownId: 'charizard' },
		{ id: 10034, slug: 'charizard-mega-x', showdownId: 'charizardmegax' },
		{ id: 678, slug: 'meowstic-male', showdownId: 'meowstic' },
		{ id: 10025, slug: 'meowstic-female', showdownId: 'meowsticf' },
	],
}];
const loaded = await loadHomeIds('http://stub', {
	attempts: 1,
	fetchImpl: (async () => new Response(JSON.stringify(stub))) as typeof fetch,
});
check('stub list loads', loaded === 4, `loaded ${loaded}`);
check('a forme resolves to its own HOME id', spriteIdFor('charizardmegax', 6, {}) === 10034);
check('a forme whose slug differs from its Showdown id resolves by the API\'s id', spriteIdFor('meowsticf', 678, {}) === 10025);
check('the team\'s own entry wins', spriteIdFor('charizard', 6, { charizard: { pokemonId: 999, shiny: false, female: false } }) === 999);
check('unknown forme falls back to the dex number', spriteIdFor('notaforme', 25, {}) === 25);
check('no dex number gives null', spriteIdFor('notaforme', undefined, {}) === null);

const failed = await loadHomeIds('http://stub', {
	attempts: 2,
	delayMs: 1,
	fetchImpl: (async () => new Response('nope', { status: 503 })) as typeof fetch,
});
check('an unreachable API is survivable', failed === 0);
// A failed reload must not discard ids that were already loaded.
check('earlier ids survive a failed reload', spriteIdFor('charizardmegax', 6, {}) === 10034);

const apiUrl = process.env.POKEPEDIA_API_URL;
if (apiUrl) {
	const count = await loadHomeIds(apiUrl, { attempts: 1 });
	check(`live API loads (${count} formes)`, count > 1000);
	check('live: Charizard-Mega-X resolves to a Mega id', (spriteIdFor('charizardmegax', 6, {}) ?? 0) > 10000);
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
