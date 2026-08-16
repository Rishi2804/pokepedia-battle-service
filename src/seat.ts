import { Battle } from '@pkmn/client';
import type { Dex as DexInterface, ID } from '@pkmn/data';
import { Generations } from '@pkmn/data';
import { Protocol } from '@pkmn/protocol';
import { Dex } from '@pkmn/sim';
import { LogFormatter } from '@pkmn/view';
import { resolveChoice } from './choices.js';
import type { PlayerStreams } from './engine.js';
import type { Choice, ServerMessage, SideID, VisualMetaMap } from './protocol.js';
import { cleanLogText, fixRequest, project } from './view.js';

type StreamSide = PlayerStreams['p1'] | PlayerStreams['p2'];
type Transport = (message: ServerMessage) => void;

/** Static dex data (species/moves/items/abilities tables) shared by every
 * Battle this process ever creates - constructing it is not cheap and it
 * has no per-battle mutable state, so one instance serves the whole server.
 *
 * @pkmn/sim's `Dex` is designed to interoperate with @pkmn/client/@pkmn/data
 * (per @pkmn/client's README: "either @pkmn/dex or @pkmn/sim must also be
 * installed to provide a Dex implementation") but their type declarations
 * don't line up exactly (e.g. `gen: number` vs `gen: GenerationNum`) - cast
 * through the structural interface @pkmn/data actually expects. */
const gens = new Generations(Dex as unknown as DexInterface);

/**
 * Raw per-seat sim protocol lines on a debug-only channel, for inspecting or
 * replaying a battle without a second protocol implementation. Not part of
 * the contract the UI renders against.
 *
 * Read lazily (not cached at module load) so a caller can set the env var
 * as its own first statement and have it take effect - ESM hoists imports,
 * so by the time this module's top-level code would otherwise run, an
 * importing script's own top-level statements (however early in its source)
 * haven't executed yet.
 */
function debugProtocolEnabled(): boolean {
	return process.env.BATTLE_DEBUG_PROTOCOL === '1';
}

/**
 * One player's seat in a room. Owns the whole server-authoritative pipeline
 * for that seat: a private @pkmn/client `Battle` fed exclusively by this
 * seat's already-redacted player stream (see engine.ts), a `LogFormatter`
 * for that seat's perspective, and the projection into `BattleView`
 * (view.ts). Nothing downstream of a seat ever touches raw sim protocol.
 *
 * A seat exists from the moment a player creates/joins - independent of
 * whether the engine has started yet - and is later bound to its player
 * stream once both players are present (Room.tryStart). The transport
 * (currently a WebSocket send callback) is swappable via attach()/detach():
 * a socket can drop and reattach mid-battle without the underlying player
 * stream ever knowing. Reconnect doesn't need historical replay - a
 * BattleView is a full snapshot each time, so attach() just resends the
 * latest one.
 */
export class Seat {
	private readonly battle: Battle;
	private readonly formatter: LogFormatter;
	private transport: Transport | null = null;
	private stream: StreamSide | null = null;
	private lastMessage: ServerMessage | null = null;
	private winner: SideID | 'tie' | null = null;
	/** `rqid` is normally added by the full PS server layer, not the raw sim
	 * (sim/SIM-PROTOCOL.md: "It will not exist if you're using the simulator
	 * directly through `import sim`" - confirmed empty in the raw request
	 * JSON during implementation). We talk to BattleStream directly, so we
	 * synthesize it ourselves: one counter per seat, incremented per request
	 * seen on that seat's own stream. */
	private rqidCounter = 0;

	constructor(
		private readonly seatId: SideID,
		private readonly format: string
	) {
		this.battle = new Battle(gens, seatId as unknown as ID);
		this.formatter = new LogFormatter(seatId, this.battle);
	}

	bindStream(stream: StreamSide, visualMeta: VisualMetaMap): void {
		this.stream = stream;
		void this.pump(stream, visualMeta);
	}

	private async pump(stream: StreamSide, visualMeta: VisualMetaMap): Promise<void> {
		for await (const chunk of stream) {
			if (!chunk) continue;
			this.processChunk(chunk, visualMeta);
		}
	}

	private processChunk(chunk: string, visualMeta: VisualMetaMap): void {
		if (debugProtocolEnabled()) this.send({ t: 'debug', lines: chunk.split('\n').filter(Boolean) });

		const log: string[] = [];
		for (const line of chunk.split('\n')) {
			if (!line) continue;

			if (line.startsWith('|request|')) {
				const payload = line.slice('|request|'.length);
				if (payload) {
					const request = fixRequest(JSON.parse(payload), Protocol);
					(request as { rqid: number }).rqid = ++this.rqidCounter;
					this.battle.update(request);
				}
				continue;
			}

			const { args, kwArgs } = Protocol.parseBattleLine(line);
			// LogFormatter must see each line before Battle.add mutates state
			// (see @pkmn/view's formatter.d.ts Tracker doc) - it needs the
			// pre-update state to word things like "before" HP percentages.
			const text = this.formatter.formatText(args, kwArgs);
			if (text) log.push(...cleanLogText(text));
			this.battle.add(args, kwArgs);

			// |win|/|tie| are public broadcast lines, present on every seat's
			// own channel - each seat can determine the winner from its own
			// stream without any cross-seat coordination.
			if (args[0] === 'win') {
				const winnerName = args[1];
				this.winner = this.battle.p1.name === winnerName ? 'p1' : this.battle.p2.name === winnerName ? 'p2' : null;
			} else if (args[0] === 'tie') {
				this.winner = 'tie';
			}
		}

		const view = project(this.battle, this.seatId, this.format, this.winner, visualMeta);
		if (this.winner !== null) {
			this.send({ t: 'end', winner: this.winner, view });
		} else {
			this.send({ t: 'update', log, view });
		}
	}

	attach(transport: Transport): void {
		this.transport = transport;
		if (this.lastMessage) transport(this.lastMessage);
	}

	detach(): void {
		this.transport = null;
	}

	send(message: ServerMessage): void {
		if (message.t === 'update' || message.t === 'end') this.lastMessage = message;
		this.transport?.(message);
	}

	choose(rqid: number, choice: Choice): void {
		if (!this.stream) return;
		const result = resolveChoice(this.battle, rqid, choice);
		if (!result.ok) {
			this.send({ t: 'error', code: 'invalid_choice', message: result.message });
			return;
		}
		void this.stream.write(result.choiceString);
	}
}
