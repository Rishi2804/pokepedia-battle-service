/**
 * Interactive terminal battle client. Connects over the same WebSocket
 * protocol the browser will use, prints the BattleView each turn, and takes
 * choices by number from the keyboard. This is the manual-testing surface
 * for Phases 1-2 (no React needed to play a battle end to end), and once
 * the UI exists it can fill the *other* seat - a browser tab vs. this
 * terminal immediately localises whether a bug is client-side or server-
 * side. It's also the exact shape a future AI seat would take: something
 * that reads a BattleView and emits a Choice.
 *
 * Usage:
 *   npm run play                    # gen 9, play vs. an in-process random bot
 *   npm run play -- --gen 5         # gen 5, vs. bot
 *   npm run play -- --create --gen 5   # create a room and wait for an external joiner, print the code
 *   npm run play -- --join ABC123 --gen 5   # join an existing room (gen must match)
 */
import { createInterface } from 'node:readline/promises';
import { Dex, Teams, TeamValidator, type PokemonSet } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';
import WebSocket from 'ws';
import { formatFor, isSupportedGen, type SupportedGen } from '../src/formats.js';
import type {
	ActiveView,
	BattleView,
	Choice,
	ClientMessage,
	RequestSwitchView,
	ServerMessage,
	SideView,
	SlotView,
} from '../src/protocol.js';

Teams.setGeneratorFactory(TeamGenerators);

const DEFAULT_WS_URL = process.env.BATTLE_WS_URL ?? 'ws://localhost:3001';
const MAX_TEAM_GEN_ATTEMPTS = 20;

interface Args {
	gen: SupportedGen;
	mode: 'vs-bot' | 'create' | 'join';
	joinCode?: string;
	wsUrl: string;
}

function parseArgs(argv: string[]): Args {
	const genIdx = argv.indexOf('--gen');
	const gen = genIdx !== -1 ? Number(argv[genIdx + 1]) : 9;
	if (!isSupportedGen(gen)) throw new Error(`--gen must be 1-9, got "${argv[genIdx + 1]}"`);

	const joinIdx = argv.indexOf('--join');
	if (joinIdx !== -1) {
		const code = argv[joinIdx + 1];
		if (!code) throw new Error('--join requires a room code');
		return { gen, mode: 'join', joinCode: code, wsUrl: DEFAULT_WS_URL };
	}
	if (argv.includes('--create')) return { gen, mode: 'create', wsUrl: DEFAULT_WS_URL };
	return { gen, mode: 'vs-bot', wsUrl: DEFAULT_WS_URL };
}

/** Same retry-until-legal approach as selfplay.ts - a random-battle team is
 * usually but not always legal for our (looser) AG ruleset. */
function legalTeamFor(gen: SupportedGen): PokemonSet[] {
	const format = Dex.formats.get(formatFor(gen), true);
	const validator = new TeamValidator(format);
	for (let attempt = 0; attempt < MAX_TEAM_GEN_ATTEMPTS; attempt++) {
		const team = Teams.generate(`gen${gen}randombattle`) as PokemonSet[];
		if (validator.validateTeam(team) === null) return team;
	}
	throw new Error(`Could not generate an AG-legal gen ${gen} team after ${MAX_TEAM_GEN_ATTEMPTS} attempts`);
}

class Connection {
	readonly ws: WebSocket;
	private readonly queue: ServerMessage[] = [];
	private waiter: ((message: ServerMessage) => void) | null = null;

	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.on('message', raw => {
			const message: ServerMessage = JSON.parse(raw.toString());
			if (message.t === 'debug') return; // not interesting for a human
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
			if (message.t === 'error') throw new Error(`server error ${message.code}: ${message.message}`);
		}
	}

	close(): void {
		this.ws.close();
	}
}

// ---- rendering ----

function hpBar(percent: number): string {
	const width = 20;
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function renderSlot(label: string, slot: SlotView, showItemAbility: boolean): string {
	const status = slot.status ? ` [${slot.status.toUpperCase()}]` : '';
	const fainted = slot.fainted ? ' (fainted)' : '';
	const tera = slot.terastallized ? ` [Tera:${slot.terastallized}]` : '';
	const extra = showItemAbility
		? ` @ ${slot.item?.name ?? '???'} | ${slot.ability?.name ?? '???'}`
		: slot.item || slot.ability
			? ` @ ${slot.item?.name ?? '-'} | ${slot.ability?.name ?? '-'}`
			: '';
	return (
		`${label} ${slot.name} Lv${slot.level} (${slot.types.join('/')})${tera}\n` +
		`  ${hpBar(slot.hpPercent)} ${slot.hp}/${slot.maxhp} (${slot.hpPercent}%)${status}${fainted}${extra}`
	);
}

function renderActive(label: string, active: ActiveView | null, showItemAbility: boolean): string {
	if (!active) return `${label}: (no active Pokemon)`;
	const boosts = Object.entries(active.boosts)
		.filter(([, v]) => v !== 0)
		.map(([k, v]) => `${k}${v! > 0 ? '+' : ''}${v}`)
		.join(' ');
	const volatiles = active.volatiles.map(v => v.name).join(', ');
	return (
		renderSlot(label, active, showItemAbility) +
		(boosts ? `\n  Boosts: ${boosts}` : '') +
		(volatiles ? `\n  Volatiles: ${volatiles}` : '')
	);
}

function renderBench(side: SideView): string {
	return side.team
		.map((p, i) => `  ${i + 1}. ${p.fainted ? '✗' : '✓'} ${p.name} (${p.hpPercent}%)${p.status ? ` [${p.status}]` : ''}`)
		.join('\n');
}

function renderView(view: BattleView): void {
	console.log('\n' + '='.repeat(60));
	console.log(`Turn ${view.turn} | ${view.format} | Gen ${view.gen} | Phase: ${view.phase}`);
	if (view.field.weather || view.field.terrain || view.field.pseudoWeather.length) {
		const parts = [
			view.field.weather?.name,
			view.field.terrain?.name,
			...view.field.pseudoWeather.map(p => p.name),
		].filter(Boolean);
		console.log(`Field: ${parts.join(', ')}`);
	}
	console.log('-'.repeat(60));
	console.log(renderActive(`Foe (${view.foe.name}):`, view.foe.active, false));
	if (view.foe.conditions.length) console.log(`  Side: ${view.foe.conditions.map(c => c.name).join(', ')}`);
	console.log(`  Team: ${view.foe.team.filter(p => !p.fainted).length}/${view.foe.teamSize} remaining`);
	console.log('-'.repeat(60));
	console.log(renderActive(`You (${view.me.name}):`, view.me.active, true));
	if (view.me.conditions.length) console.log(`  Side: ${view.me.conditions.map(c => c.name).join(', ')}`);
	console.log('Your team:');
	console.log(renderBench(view.me));
	console.log('='.repeat(60));
}

// ---- interactive choice prompting ----

const rl = createInterface({ input: process.stdin, output: process.stdout });

function switchableBench(canSwitch: RequestSwitchView[]): RequestSwitchView[] {
	return canSwitch.filter(p => !p.active && !p.fainted);
}

async function promptChoice(view: BattleView): Promise<Choice | null> {
	const req = view.request;
	if (!req) return null;

	if (req.kind === 'wait') {
		console.log('Waiting for opponent...');
		return null;
	}

	if (req.kind === 'teampreview') {
		console.log('\nTeam preview - your team:');
		for (const p of req.canSwitch) console.log(`  ${p.index}. ${p.name}`);
		const answer = await rl.question(`Enter lead order (e.g. "314265"), or Enter for default: `);
		const digits = answer.trim();
		const order = digits ? digits.split('').map(Number) : req.canSwitch.map(p => p.index);
		return { kind: 'team', order };
	}

	if (req.kind === 'switch') {
		const bench = switchableBench(req.canSwitch);
		console.log('\nYou must switch:');
		for (const p of bench) console.log(`  ${p.index}. ${p.name}`);
		const answer = await rl.question('Switch to: ');
		return { kind: 'switch', index: Number(answer.trim()) };
	}

	// move
	console.log('\nMoves:');
	for (const m of req.moves) {
		const flag = m.disabled ? ' [DISABLED]' : '';
		console.log(`  ${m.index}. ${m.name} (${m.type}, ${m.category}) ${m.pp}/${m.maxpp}pp${flag}`);
	}
	const bench = req.trapped ? [] : switchableBench(req.canSwitch);
	if (bench.length > 0) {
		console.log('Switch instead:');
		for (const p of bench) console.log(`  s${p.index}. Switch to ${p.name}`);
	}
	const specials: string[] = [];
	if (req.special.tera) specials.push(`t (Terastallize to ${req.special.tera.type})`);
	if (req.special.mega) specials.push('append "mega" to your move, e.g. "1 mega"');
	if (req.special.dynamax) specials.push('append "max" to your move, e.g. "1 max"');
	if (specials.length) console.log(`Available: ${specials.join('; ')}`);

	const answer = (await rl.question('Choice: ')).trim();
	if (answer.startsWith('s')) {
		return { kind: 'switch', index: Number(answer.slice(1)) };
	}
	const parts = answer.split(/\s+/);
	const index = Number(parts[0]);
	const modifier = parts[1];
	return {
		kind: 'move',
		index,
		tera: modifier === 'tera' || modifier === 't',
		mega: modifier === 'mega',
		dynamax: modifier === 'max',
	};
}

// ---- an in-process random bot, for the default "just let me play" mode ----

async function runBot(connection: Connection, gen: SupportedGen, code: string): Promise<void> {
	const team = legalTeamFor(gen);
	connection.send({ t: 'join', code, name: 'Bot', team, visualMeta: {} });
	await connection.waitFor('joined');

	let respondedRqid: number | null = null;
	for (;;) {
		const message = await connection.next();
		if (message.t === 'end' || message.t === 'error') return;
		if (message.t !== 'update') continue;
		const req = message.view.request;
		if (!req || req.rqid === respondedRqid) continue;
		respondedRqid = req.rqid;

		let choice: Choice | null = null;
		if (req.kind === 'teampreview') {
			choice = { kind: 'team', order: req.canSwitch.map(p => p.index) };
		} else if (req.kind === 'switch') {
			const bench = switchableBench(req.canSwitch);
			if (bench.length) choice = { kind: 'switch', index: bench[0].index };
		} else if (req.kind === 'move') {
			const usable = req.moves.find(m => !m.disabled);
			choice = usable ? { kind: 'move', index: usable.index } : { kind: 'move', index: 1 };
		}
		if (choice) connection.send({ t: 'choose', rqid: req.rqid, choice });
	}
}

// ---- main ----

async function playAsHuman(connection: Connection): Promise<void> {
	let respondedRqid: number | null = null;
	for (;;) {
		const message = await connection.next();

		if (message.t === 'error') {
			console.log(`\n! ${message.message}`);
			continue;
		}
		if (message.t === 'roomState') {
			console.log(`Room: ${message.phase} | players: ${JSON.stringify(message.players)}`);
			continue;
		}
		if (message.t === 'end') {
			renderView(message.view);
			console.log(`\nBattle over. Winner: ${message.view.winner ?? 'none'}`);
			return;
		}
		if (message.t !== 'update') continue;

		if (message.log.length) console.log('\n' + message.log.join('\n'));
		renderView(message.view);

		const req = message.view.request;
		if (!req || req.rqid === respondedRqid) continue;

		for (;;) {
			const choice = await promptChoice(message.view);
			if (!choice) break;
			respondedRqid = req.rqid;
			connection.send({ t: 'choose', rqid: req.rqid, choice });
			break;
		}
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const connection = new Connection(args.wsUrl);
	await connection.ready();

	const team = legalTeamFor(args.gen);

	if (args.mode === 'join') {
		connection.send({ t: 'join', code: args.joinCode!, name: 'Player', team, visualMeta: {} });
		const joined = await connection.waitFor('joined');
		console.log(`Joined room ${joined.code} as ${joined.seat}.`);
	} else {
		connection.send({ t: 'create', gen: args.gen, name: 'Player', team, visualMeta: {} });
		const created = await connection.waitFor('created');
		console.log(`Created room ${created.code} as ${created.seat} (${created.format}).`);

		if (args.mode === 'vs-bot') {
			const bot = new Connection(args.wsUrl);
			await bot.ready();
			void runBot(bot, args.gen, created.code);
		} else {
			console.log(`Waiting for an opponent to join with code: ${created.code}`);
		}
	}

	await playAsHuman(connection);
	rl.close();
	connection.close();
	process.exit(0);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
