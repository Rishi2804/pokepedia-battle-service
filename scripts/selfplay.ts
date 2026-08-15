/**
 * Random-vs-random battle runner - the regression net for engine wiring.
 * Spins up the battle server in-process on an ephemeral port, plays a full
 * battle for one or all supported gens with randomly generated (but
 * format-legal) teams, and asserts the core privacy invariant: neither
 * seat's stream ever carries the other seat's `|request|`.
 *
 * Usage: npm run selfplay [-- --gen N] [-- --verbose]
 */
import { Dex, Teams, TeamValidator, type PokemonSet } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';
import WebSocket from 'ws';
import { createBattleServer } from '../src/index.js';
import { type SupportedGen, formatFor, isSupportedGen } from '../src/formats.js';
import type { ClientMessage, ServerMessage } from '../src/protocol.js';

Teams.setGeneratorFactory(TeamGenerators);

const ALL_GENS: SupportedGen[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const BATTLE_TIMEOUT_MS = 30_000;
const MAX_TEAM_GEN_ATTEMPTS = 20;
const MAX_CHOICE_RETRIES = 5;

interface Args {
	gens: SupportedGen[];
	verbose: boolean;
}

function parseArgs(argv: string[]): Args {
	const verbose = argv.includes('--verbose');
	const genIdx = argv.indexOf('--gen');
	if (genIdx !== -1) {
		const gen = Number(argv[genIdx + 1]);
		if (!isSupportedGen(gen)) throw new Error(`--gen must be 1-9, got "${argv[genIdx + 1]}"`);
		return { gens: [gen], verbose };
	}
	return { gens: ALL_GENS, verbose };
}

/** A team from the random-battle generator is not automatically legal for a
 * different format (Anything Goes has looser bans but stricter obtainability
 * in a few edge cases - e.g. gen 1 Mewtwo's level, gen 5 hidden-ability
 * interactions). Retrying with a fresh roll clears these in practice within
 * a handful of attempts (verified during implementation: worst case seen
 * was 2 attempts out of 9 gens). */
function legalTeamFor(gen: SupportedGen, formatId: string): PokemonSet[] {
	const format = Dex.formats.get(formatId, true);
	const validator = new TeamValidator(format);
	for (let attempt = 0; attempt < MAX_TEAM_GEN_ATTEMPTS; attempt++) {
		const team = Teams.generate(`gen${gen}randombattle`) as PokemonSet[];
		if (validator.validateTeam(team) === null) return team;
	}
	throw new Error(`Could not generate an AG-legal gen ${gen} team after ${MAX_TEAM_GEN_ATTEMPTS} attempts`);
}

interface ShowdownRequest {
	rqid: number;
	wait?: boolean;
	teamPreview?: boolean;
	forceSwitch?: boolean[];
	active?: { moves: { move: string; disabled?: boolean }[]; trapped?: boolean }[];
	side: { pokemon: { active: boolean; condition: string }[] };
}

function randomOf<T>(items: T[]): T {
	return items[Math.floor(Math.random() * items.length)];
}

function aliveBench(request: ShowdownRequest): number[] {
	return request.side.pokemon
		.map((p, i) => ({ slot: i + 1, p }))
		.filter(({ p }) => !p.active && !p.condition.endsWith(' fnt'))
		.map(({ slot }) => slot);
}

/** Picks a plausible choice from a raw sim `|request|` payload. Not a
 * general-purpose choice builder (that's @pkmn/view's ChoiceBuilder, Phase 2)
 * - just enough to drive a battle to completion for this test harness. */
function chooseFor(request: ShowdownRequest): string | null {
	if (request.wait) return null;
	if (request.teamPreview) {
		const size = request.side.pokemon.length;
		const order = Array.from({ length: size }, (_, i) => i + 1);
		for (let i = order.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[order[i], order[j]] = [order[j], order[i]];
		}
		return `team ${order.join('')}`;
	}
	if (request.forceSwitch) {
		const bench = aliveBench(request);
		if (bench.length === 0) return 'pass';
		return `switch ${randomOf(bench)}`;
	}
	if (request.active) {
		const activeReq = request.active[0];
		const usable = activeReq.moves.map((m, i) => ({ slot: i + 1, m })).filter(({ m }) => !m.disabled);
		const bench = activeReq.trapped ? [] : aliveBench(request);
		if (bench.length > 0 && Math.random() < 0.15) return `switch ${randomOf(bench)}`;
		if (usable.length === 0) return 'move 1';
		return `move ${randomOf(usable).slot}`;
	}
	return null;
}

class TestClient {
	readonly ws: WebSocket;
	readonly seenLines: string[] = [];
	private readonly queue: ServerMessage[] = [];
	private waiter: ((message: ServerMessage) => void) | null = null;

	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.on('message', raw => {
			const message: ServerMessage = JSON.parse(raw.toString());
			if (message.t === 'update') this.seenLines.push(...message.lines);
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

/** Drives one seat: replies to every |request| it sees until the battle
 * ends, retrying with a fresh random choice on |error|[Invalid choice]. */
async function driveSeat(client: TestClient, ownSeat: 'p1' | 'p2'): Promise<{ winner: string | null }> {
	let lastRequest: ShowdownRequest | null = null;
	let retries = 0;

	for (;;) {
		const message = await client.next();

		if (message.t === 'end') return { winner: message.winner };
		if (message.t === 'error') throw new Error(`${ownSeat} server error ${message.code}: ${message.message}`);
		if (message.t !== 'update') continue;

		for (const line of message.lines) {
			if (line.startsWith('|request|')) {
				const payload = line.slice('|request|'.length);
				if (!payload) continue;
				lastRequest = JSON.parse(payload) as ShowdownRequest;
				retries = 0;
			}
			if (line.startsWith('|error|') && lastRequest) {
				retries++;
				if (retries > MAX_CHOICE_RETRIES) {
					client.send({ t: 'choose', choice: 'default' });
				} else {
					const choice = chooseFor(lastRequest);
					if (choice) client.send({ t: 'choose', choice });
				}
			}
		}

		if (lastRequest && !message.lines.some(l => l.startsWith('|error|'))) {
			const choice = chooseFor(lastRequest);
			if (choice) {
				client.send({ t: 'choose', choice });
				lastRequest = null;
			}
		}
	}
}

interface PrivacyViolation {
	seat: 'p1' | 'p2';
	line: string;
}

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

async function runBattle(wsUrl: string, gen: SupportedGen, verbose: boolean): Promise<void> {
	const format = formatFor(gen);
	const team1 = legalTeamFor(gen, format);
	const team2 = legalTeamFor(gen, format);

	const p1 = new TestClient(wsUrl);
	const p2 = new TestClient(wsUrl);
	await Promise.all([p1.ready(), p2.ready()]);

	p1.send({ t: 'create', gen, name: 'Player 1', team: team1, visualMeta: {} });
	const created = await p1.waitFor('created');

	p2.send({ t: 'join', code: created.code, name: 'Player 2', team: team2, visualMeta: {} });
	await p2.waitFor('joined');

	const battle = Promise.all([driveSeat(p1, 'p1'), driveSeat(p2, 'p2')]);
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error(`gen ${gen} battle exceeded ${BATTLE_TIMEOUT_MS}ms`)), BATTLE_TIMEOUT_MS)
	);
	const [p1Result, p2Result] = await Promise.race([battle, timeout]);

	const violations = checkPrivacy(p1.seenLines, p2.seenLines);
	p1.close();
	p2.close();

	if (violations.length > 0) {
		throw new Error(
			`gen ${gen}: privacy violation - ${violations.length} request(s) leaked to the wrong seat: ` +
				violations.map(v => `${v.seat} saw ${v.line.slice(0, 80)}`).join('; ')
		);
	}
	if (p1Result.winner !== p2Result.winner) {
		throw new Error(`gen ${gen}: seats disagree on winner (p1 saw ${p1Result.winner}, p2 saw ${p2Result.winner})`);
	}

	console.log(
		`gen ${gen} (${format}): OK - winner=${p1Result.winner ?? 'none'}, ` +
			`p1 saw ${p1.seenLines.length} lines, p2 saw ${p2.seenLines.length} lines, no privacy violations`
	);
	if (verbose) {
		console.log(`  --- p1 perspective ---`);
		for (const line of p1.seenLines) console.log(`  p1> ${line}`);
		console.log(`  --- p2 perspective ---`);
		for (const line of p2.seenLines) console.log(`  p2> ${line}`);
	}
}

async function main(): Promise<void> {
	const { gens, verbose } = parseArgs(process.argv.slice(2));
	const handle = createBattleServer();
	await new Promise<void>(resolve => handle.server.listen(0, resolve));
	const address = handle.server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	const wsUrl = `ws://127.0.0.1:${port}`;

	const failures: string[] = [];
	for (const gen of gens) {
		try {
			await runBattle(wsUrl, gen, verbose);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`gen ${gen}: FAILED - ${message}`);
			failures.push(`gen ${gen}: ${message}`);
		}
	}

	await handle.close();

	if (failures.length > 0) {
		console.error(`\n${failures.length}/${gens.length} gen(s) failed.`);
		process.exitCode = 1;
	} else {
		console.log(`\nAll ${gens.length} gen(s) passed.`);
	}
}

main().catch(err => {
	console.error(err);
	process.exitCode = 1;
});
