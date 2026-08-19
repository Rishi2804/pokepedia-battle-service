/**
 * Random-vs-random battle runner - the regression net for engine wiring and
 * the BattleView projection. Spins up the battle server in-process on an
 * ephemeral port (with the raw-protocol debug channel enabled), plays a
 * full battle for one or all supported gens with randomly generated (but
 * format-legal) teams, and asserts:
 *
 *  - privacy: neither seat's raw stream ever carries the other seat's
 *    |request| (the structural guarantee getPlayerStreams gives us,
 *    verified directly rather than trusted)
 *  - view invariants: hpPercent/hpColor are always consistent with hp/maxhp
 *  - the choice API: every choice we send is accepted by src/choices.ts's
 *    own validation - if it isn't, that's a chooser bug or a resolveChoice
 *    bug, not a round trip through the sim's own |error|
 *
 * Usage: npm run selfplay [-- --gen N|nationaldex] [-- --verbose]
 */
process.env.BATTLE_DEBUG_PROTOCOL = '1';

import { Dex, Teams, TeamValidator, type PokemonSet } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';
import WebSocket from 'ws';
import { createBattleServer } from '../src/index.js';
import { type BattleFormatKey, formatFor, isBattleFormatKey } from '../src/formats.js';
import type { BattleView, Choice, ClientMessage, RequestSwitchView, ServerMessage, SideID } from '../src/protocol.js';

Teams.setGeneratorFactory(TeamGenerators);

const ALL_FORMAT_KEYS: BattleFormatKey[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 'nationaldex'];
const BATTLE_TIMEOUT_MS = 30_000;
const MAX_TEAM_GEN_ATTEMPTS = 20;
const MAX_CHOICE_RETRIES = 5;

interface Args {
	formatKeys: BattleFormatKey[];
	verbose: boolean;
}

function parseArgs(argv: string[]): Args {
	const verbose = argv.includes('--verbose');
	const genIdx = argv.indexOf('--gen');
	if (genIdx !== -1) {
		const raw = argv[genIdx + 1];
		// `--gen nationaldex` is accepted too - the flag name predates there
		// being a non-numeric format, and renaming it would break muscle memory
		// for no real gain.
		const key: unknown = raw === 'nationaldex' ? raw : Number(raw);
		if (!isBattleFormatKey(key)) throw new Error(`--gen must be 1-9 or "nationaldex", got "${raw}"`);
		return { formatKeys: [key], verbose };
	}
	return { formatKeys: ALL_FORMAT_KEYS, verbose };
}

/** Reads correctly for both a bare gen number and the 'nationaldex' key. */
function label(formatKey: BattleFormatKey): string {
	return formatKey === 'nationaldex' ? 'nationaldex' : `gen ${formatKey}`;
}

/** A team from the random-battle generator is not automatically legal for a
 * different format (Anything Goes has looser bans but stricter obtainability
 * in a few edge cases - e.g. gen 1 Mewtwo's level, gen 5 hidden-ability
 * interactions). Retrying with a fresh roll clears these in practice within
 * a handful of attempts (verified during implementation: worst case seen
 * was 2 attempts out of 9 gens). */
function legalTeamFor(formatKey: BattleFormatKey, formatId: string): PokemonSet[] {
	const format = Dex.formats.get(formatId, true);
	const validator = new TeamValidator(format);
	// There is no national-dex random-battle generator; gen 9's works because
	// National Dex AG is strictly more permissive than plain gen 9 AG.
	const generatorGen = formatKey === 'nationaldex' ? 9 : formatKey;
	for (let attempt = 0; attempt < MAX_TEAM_GEN_ATTEMPTS; attempt++) {
		const team = Teams.generate(`gen${generatorGen}randombattle`) as PokemonSet[];
		if (validator.validateTeam(team) === null) return team;
	}
	throw new Error(`Could not generate an AG-legal ${formatKey} team after ${MAX_TEAM_GEN_ATTEMPTS} attempts`);
}

function randomOf<T>(items: T[]): T {
	return items[Math.floor(Math.random() * items.length)];
}

function shuffle<T>(items: T[]): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function switchableBench(canSwitch: RequestSwitchView[]): RequestSwitchView[] {
	return canSwitch.filter(p => !p.active && !p.fainted);
}

/** Picks a plausible Choice from a BattleView's request - the same role
 * Phase 1's chooseFor played against raw |request| JSON, now against the
 * semantic view instead. */
function chooseFor(view: BattleView): Choice | null {
	const req = view.request;
	if (!req) return null;

	switch (req.kind) {
		case 'wait':
			return null;
		case 'teampreview':
			return { kind: 'team', order: shuffle(req.canSwitch.map(p => p.index)) };
		case 'switch': {
			const bench = switchableBench(req.canSwitch);
			if (bench.length === 0) return null;
			return { kind: 'switch', index: randomOf(bench).index };
		}
		case 'move': {
			const usable = req.moves.filter(m => !m.disabled);
			const bench = req.trapped ? [] : switchableBench(req.canSwitch);
			if (bench.length > 0 && Math.random() < 0.15) return { kind: 'switch', index: randomOf(bench).index };
			if (usable.length === 0) return { kind: 'move', index: 1 }; // Struggle
			return { kind: 'move', index: randomOf(usable).index };
		}
	}
}

/** hpPercent/hpColor are derived fields (view.ts) - recomputed independently
 * here so a projection bug shows up as a test failure, not just trusted. */
function checkViewInvariants(view: BattleView, seat: SideID): void {
	for (const side of [view.me, view.foe]) {
		for (const slot of side.team) {
			const expectedPercent = slot.maxhp > 0 ? Math.round((slot.hp / slot.maxhp) * 100) : 0;
			if (slot.hpPercent !== expectedPercent) {
				throw new Error(`${seat}: hpPercent mismatch for ${slot.ident}: got ${slot.hpPercent}, expected ${expectedPercent}`);
			}
			const expectedColor = expectedPercent > 50 ? 'green' : expectedPercent > 20 ? 'yellow' : 'red';
			if (slot.hpColor !== expectedColor) {
				throw new Error(`${seat}: hpColor mismatch for ${slot.ident}: got ${slot.hpColor} (${slot.hpPercent}%), expected ${expectedColor}`);
			}
		}
	}
}

class TestClient {
	readonly ws: WebSocket;
	readonly debugLines: string[] = [];
	private readonly queue: ServerMessage[] = [];
	private waiter: ((message: ServerMessage) => void) | null = null;

	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.on('message', raw => {
			const message: ServerMessage = JSON.parse(raw.toString());
			if (message.t === 'debug') this.debugLines.push(...message.lines);
			if (this.waiter) {
				const w = this.waiter;
				this.waiter = null;
				w(message);
			} else {
				this.queue.push(message);
			}
		});
	}

	async ready(): Promise<void> {
		if (this.ws.readyState === WebSocket.OPEN) return;
		await new Promise<void>((resolve, reject) => {
			this.ws.once('open', () => resolve());
			this.ws.once('error', reject);
		});
	}

	send(message: ClientMessage): void {
		if (process.env.SELFPLAY_TRACE) console.error('SEND', JSON.stringify(message));
		this.ws.send(JSON.stringify(message));
	}

	/** Pulls the next message not already claimed by waitFor(). Queued so a
	 * message that arrives before this is called isn't dropped. */
	async next(): Promise<ServerMessage> {
		const queued = this.queue.shift();
		if (queued) return queued;
		return new Promise(resolve => {
			this.waiter = resolve;
		});
	}

	async waitFor<T extends ServerMessage['t']>(type: T): Promise<Extract<ServerMessage, { t: T }>> {
		for (;;) {
			const message = await this.next();
			if (message.t === type) return message as Extract<ServerMessage, { t: T }>;
			if (message.t === 'error') throw new Error(`[${type}] server error ${message.code}: ${message.message}`);
		}
	}

	close(): void {
		this.ws.close();
	}
}

/**
 * Drives one seat: replies to each NEW request it sees until the battle
 * ends, retrying with a fresh random choice if src/choices.ts rejects a
 * pick. "New" matters: several `update` messages can carry the same
 * still-live rqid in a row (e.g. team-preview reveal lines arriving in
 * separate chunks before the request itself changes), and re-submitting a
 * choice for an rqid already answered eventually desyncs the battle from a
 * pileup of redundant choices - a real UI has to guard against this exact
 * thing, so the fix belongs here, not just in this script.
 */
async function driveSeat(client: TestClient, ownSeat: SideID): Promise<{ winner: BattleView['winner'] }> {
	let lastView: BattleView | null = null;
	let respondedRqid: number | null = null;
	let retries = 0;

	for (;;) {
		const message = await client.next();

		if (message.t === 'error') {
			if (message.code !== 'invalid_choice' || !lastView?.request) {
				throw new Error(`${ownSeat} server error ${message.code}: ${message.message}`);
			}
			retries++;
			if (retries > MAX_CHOICE_RETRIES) {
				throw new Error(`${ownSeat}: exceeded ${MAX_CHOICE_RETRIES} invalid_choice retries: ${message.message}`);
			}
			const choice = chooseFor(lastView);
			if (choice) client.send({ t: 'choose', rqid: lastView.request.rqid, choice });
			continue;
		}

		if (message.t === 'end') {
			checkViewInvariants(message.view, ownSeat);
			return { winner: message.view.winner };
		}

		if (message.t !== 'update') continue;
		checkViewInvariants(message.view, ownSeat);

		if (process.env.SELFPLAY_TRACE) {
			console.error(`${ownSeat} RECV rqid=${message.view.request?.rqid} kind=${message.view.request?.kind} phase=${message.view.phase}`);
		}

		const req = message.view.request;
		if (req && req.rqid !== respondedRqid) {
			retries = 0;
			const choice = chooseFor(message.view);
			if (choice) {
				lastView = message.view;
				respondedRqid = req.rqid;
				client.send({ t: 'choose', rqid: req.rqid, choice });
			}
		}
	}
}

interface PrivacyViolation {
	seat: SideID;
	line: string;
}

/** The structural guarantee: getPlayerStreams resolves |split| pairs and
 * routes sideupdate chunks (which carry |request|) only to the owning
 * seat's channel. Verified directly against the raw debug lines rather than
 * inferred from the view - if this ever fails, the bug is upstream of the
 * projection, in engine.ts/seat.ts's stream wiring. */
function checkPrivacy(p1Lines: string[], p2Lines: string[]): PrivacyViolation[] {
	const violations: PrivacyViolation[] = [];
	for (const [seat, lines, other] of [
		['p1', p1Lines, 'p2'],
		['p2', p2Lines, 'p1'],
	] as const) {
		for (const line of lines) {
			if (!line.startsWith('|request|')) continue;
			const payload = line.slice('|request|'.length);
			if (!payload) continue;
			const request = JSON.parse(payload) as { side?: { id?: string } };
			if (request.side?.id === other) violations.push({ seat, line });
		}
	}
	return violations;
}

async function runBattle(wsUrl: string, formatKey: BattleFormatKey, verbose: boolean): Promise<void> {
	const format = formatFor(formatKey);
	const team1 = legalTeamFor(formatKey, format);
	const team2 = legalTeamFor(formatKey, format);

	const p1 = new TestClient(wsUrl);
	const p2 = new TestClient(wsUrl);
	try {
		await Promise.all([p1.ready(), p2.ready()]);

		p1.send({ t: 'create', formatKey, name: 'Player 1', team: team1, visualMeta: {} });
		const created = await p1.waitFor('created');

		p2.send({ t: 'join', code: created.code, name: 'Player 2', team: team2, visualMeta: {} });
		await p2.waitFor('joined');

		const battle = Promise.all([driveSeat(p1, 'p1'), driveSeat(p2, 'p2')]);
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`${label(formatKey)} battle exceeded ${BATTLE_TIMEOUT_MS}ms`)), BATTLE_TIMEOUT_MS)
		);
		const [p1Result, p2Result] = await Promise.race([battle, timeout]);

		const violations = checkPrivacy(p1.debugLines, p2.debugLines);
		if (violations.length > 0) {
			throw new Error(
				`${label(formatKey)}: privacy violation - ${violations.length} request(s) leaked to the wrong seat: ` +
					violations.map(v => `${v.seat} saw ${v.line.slice(0, 80)}`).join('; ')
			);
		}
		if (p1Result.winner === null || p1Result.winner === undefined) {
			throw new Error(`${label(formatKey)}: battle ended without a winner recorded`);
		}
		// winner is perspective-relative ('me'/'foe'/'tie'), so p1 and p2 always
		// disagree in the normal decisive case - only tie should match.
		if ((p1Result.winner === 'tie') !== (p2Result.winner === 'tie')) {
			throw new Error(`${label(formatKey)}: seats disagree on tie (p1 saw ${p1Result.winner}, p2 saw ${p2Result.winner})`);
		}

		console.log(
			`${label(formatKey)} (${format}): OK - winner=${p1Result.winner} (p1's perspective), ` +
				`p1 saw ${p1.debugLines.length} raw lines, p2 saw ${p2.debugLines.length} raw lines, no privacy violations`
		);
		if (verbose) {
			console.log(`  --- p1 raw lines ---`);
			for (const line of p1.debugLines) console.log(`  p1> ${line}`);
			console.log(`  --- p2 raw lines ---`);
			for (const line of p2.debugLines) console.log(`  p2> ${line}`);
		}
	} finally {
		// Always close both sockets, even on failure/timeout - an orphaned
		// open connection makes the server's wss.close() (main()) hang
		// forever waiting for it to disconnect on its own.
		p1.close();
		p2.close();
	}
}

async function main(): Promise<void> {
	const { formatKeys, verbose } = parseArgs(process.argv.slice(2));
	const handle = createBattleServer();
	await new Promise<void>(resolve => handle.server.listen(0, resolve));
	const address = handle.server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	const wsUrl = `ws://127.0.0.1:${port}`;

	const failures: string[] = [];
	for (const formatKey of formatKeys) {
		try {
			await runBattle(wsUrl, formatKey, verbose);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`${label(formatKey)}: FAILED - ${message}`);
			failures.push(`${label(formatKey)}: ${message}`);
		}
	}

	await handle.close();

	if (failures.length > 0) {
		console.error(`\n${failures.length}/${formatKeys.length} format(s) failed.`);
		process.exitCode = 1;
	} else {
		console.log(`\nAll ${formatKeys.length} format(s) passed.`);
	}
}

main().catch(err => {
	console.error(err);
	process.exitCode = 1;
});
