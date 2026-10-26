/**
 * Checks POST /validate: the same problems creating a room would report, for a
 * team that is still being edited. Starts the server on an ephemeral port.
 *
 * Usage: npm run validatecheck
 */
import type { AddressInfo } from 'node:net';
import { createBattleServer } from '../src/index.js';
import type { BattleTeamMember } from '../src/protocol.js';

const spread = (n: number) => ({ hp: n, atk: n, def: n, spa: n, spd: n, spe: n });
const member = (showdownId: string, moves: string[], overrides: Partial<BattleTeamMember> = {}): BattleTeamMember => ({
	pokemonId: 1, slug: showdownId, showdownId, nickname: null, shiny: false, gender: 'genderless', ability: null, moves,
	level: 100, nature: 'hardy', item: null, evs: spread(84), ivs: spread(31), happiness: 255, teraType: null,
	dynamaxLevel: 10, gigantamax: false, ...overrides,
});

const handle = createBattleServer({ allowedOrigins: ['http://localhost:1513'] });
await new Promise<void>(resolve => handle.server.listen(0, resolve));
const base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;

const post = (body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${base}/validate`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` - ${detail}`}`);
	if (!ok) failures++;
}

// Scarlet/Violet: Garchomp with a legal set.
const legal = await post({ versionGroup: 'SCARLET_VIOLET', team: [member('garchomp', ['Earthquake', 'Dragon Claw', 'Swords Dance', 'Protect'], { item: 'lifeorb', ability: 'Rough Skin' })] });
const legalBody = await legal.json() as { valid: boolean; problems: string[] };
check('a legal team is valid', legal.status === 200 && legalBody.valid && legalBody.problems.length === 0, JSON.stringify(legalBody));

const unknownMove = await (await post({ versionGroup: 'SCARLET_VIOLET', team: [member('mewtwo', ['Not A Move'])] })).json() as { valid: boolean; problems: string[] };
check('an unknown move is a problem', !unknownMove.valid && unknownMove.problems.some(p => p.includes('unknown move "Not A Move"')), JSON.stringify(unknownMove));

const notLearnable = await (await post({ versionGroup: 'SCARLET_VIOLET', team: [member('pikachu', ['Hyper Beam', 'Earthquake', 'Thunderbolt', 'Surf'])] })).json() as { valid: boolean; problems: string[] };
check('a move the species cannot learn is a validator problem', !notLearnable.valid && notLearnable.problems.length > 0, JSON.stringify(notLearnable));

const wrongGenItem = await (await post({ versionGroup: 'SCARLET_VIOLET', team: [member('venusaur', ['Giga Drain'], { item: 'venusaurite' })] })).json() as { valid: boolean; problems: string[] };
check('a Mega Stone in a gen 9 team is a validator problem', !wrongGenItem.valid && wrongGenItem.problems.length > 0, JSON.stringify(wrongGenItem));

const mega = await (await post({ versionGroup: null, team: [member('charizardmegax', ['Flare Blitz', 'Dragon Claw', 'Earthquake', 'Swords Dance'])] })).json() as { valid: boolean; problems: string[] };
check('a Home team with a Mega is valid (base + Mega Stone)', mega.valid, JSON.stringify(mega));

const empty = await (await post({ versionGroup: null, team: [] })).json() as { valid: boolean; problems: string[] };
check('an empty team gets a response, not a crash', typeof empty.valid === 'boolean', JSON.stringify(empty));

check('malformed JSON is a 400', (await post('{nope')).status === 400);
check('a payload with no team is a 400', (await post({ versionGroup: null })).status === 400);
check('a team member missing showdownId is a 400', (await post({ versionGroup: null, team: [{ ...member('mewtwo', []), showdownId: undefined }] })).status === 400);
check('a bad version group is a 400', (await post({ versionGroup: 'NOT_A_GAME', team: [] })).status === 400);
check('an oversized body is rejected', [413, 0].includes((await post('x'.repeat(300_000)).catch(() => ({ status: 0 }))).status));

const get = await fetch(`${base}/validate`);
check('GET is a 405', get.status === 405);

const preflight = await fetch(`${base}/validate`, { method: 'OPTIONS', headers: { origin: 'http://localhost:1513', 'access-control-request-method': 'POST' } });
check('the CORS preflight allows POST from the app', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === 'http://localhost:1513' && (preflight.headers.get('access-control-allow-methods') ?? '').includes('POST'));
const foreign = await post({ versionGroup: null, team: [] }, { origin: 'http://evil.example' });
check('a foreign origin gets no CORS header', foreign.headers.get('access-control-allow-origin') === null);

await handle.close();
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
