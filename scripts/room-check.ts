/**
 * Checks the room lookup endpoint and the version-group lock on join:
 *  - GET /rooms/:code returns the room's version group, format name, host and
 *    whether it can still be joined; an unknown code is a 404
 *  - joining with a team from a different version group is rejected with
 *    gen_mismatch, and a matching one is accepted
 *
 * Usage: npm run roomcheck
 */
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createBattleServer } from '../src/index.js';
import type { BattleTeamMember, ClientMessage, ServerMessage } from '../src/protocol.js';

const zero = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const member = (slug: string, moves: string[]): BattleTeamMember => ({
	pokemonId: 1, slug, nickname: null, shiny: false, gender: 'genderless', ability: null, moves, level: 100,
	nature: 'hardy', item: null, evs: { ...zero, hp: 84 }, ivs: { hp: 15, atk: 15, def: 15, spa: 15, spd: 15, spe: 15 },
	happiness: 255, teraType: null, dynamaxLevel: 10, gigantamax: false,
});
const TEAM = [member('mewtwo', ['Psychic'])];

const sockets: WebSocket[] = [];

async function request(port: number, message: ClientMessage): Promise<ServerMessage> {
	const ws = new WebSocket(`ws://localhost:${port}`);
	sockets.push(ws);
	await new Promise(resolve => ws.once('open', resolve));
	// roomState broadcasts can arrive first - wait for the actual outcome.
	const reply = new Promise<ServerMessage>(resolve => ws.on('message', data => {
		const message = JSON.parse(data.toString()) as ServerMessage;
		if (message.t === 'created' || message.t === 'joined' || message.t === 'error') resolve(message);
	}));
	ws.send(JSON.stringify(message));
	const result = await reply;
	return result;
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` - ${detail}`}`);
	if (!ok) failures++;
}

const handle = createBattleServer();
await new Promise<void>(resolve => handle.server.listen(0, resolve));
const port = (handle.server.address() as AddressInfo).port;

try {
	const created = await request(port, { t: 'create', versionGroup: 'GOLD_SILVER', name: 'Host', team: TEAM });
	if (created.t !== 'created') throw new Error(`create failed: ${JSON.stringify(created)}`);

	const lookup = await fetch(`http://localhost:${port}/rooms/${created.code}`);
	const info = await lookup.json() as Record<string, unknown>;
	check('lookup returns the room', lookup.status === 200 && info.versionGroup === 'GOLD_SILVER' && info.formatName === 'Gen 2 Anything Goes' && info.host === 'Host' && info.joinable === true, JSON.stringify(info));
	check('lookup is case-insensitive', (await fetch(`http://localhost:${port}/rooms/${created.code.toLowerCase()}`)).status === 200);
	check('lookup allows cross-origin reads', lookup.headers.get('access-control-allow-origin') === '*');
	check('unknown room is a 404', (await fetch(`http://localhost:${port}/rooms/ZZZZZZ`)).status === 404);

	const mismatch = await request(port, { t: 'join', code: created.code, versionGroup: 'CRYSTAL', name: 'Guest', team: TEAM });
	check('different version group is rejected', mismatch.t === 'error' && mismatch.code === 'gen_mismatch', JSON.stringify(mismatch));
	const homeMismatch = await request(port, { t: 'join', code: created.code, versionGroup: null, name: 'Guest', team: TEAM });
	check('Home team cannot join a game-specific room', homeMismatch.t === 'error' && homeMismatch.code === 'gen_mismatch', JSON.stringify(homeMismatch));

	const joined = await request(port, { t: 'join', code: created.code, versionGroup: 'GOLD_SILVER', name: 'Guest', team: TEAM });
	check('matching version group joins', joined.t === 'joined', JSON.stringify(joined));

	const full = await (await fetch(`http://localhost:${port}/rooms/${created.code}`)).json() as Record<string, unknown>;
	check('full room reports joinable: false', full.joinable === false, JSON.stringify(full));
} finally {
	// Seated sockets keep the server open, so drop them before closing it.
	for (const ws of sockets) ws.terminate();
	await handle.close();
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
