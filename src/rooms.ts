import { randomInt, randomUUID } from 'node:crypto';
import type { PokemonSet } from '@pkmn/sim';
import { BattleEngine } from './engine.js';
import { formatFor, type SupportedGen } from './formats.js';
import type { Choice, RoomPhase, ServerMessage, SideID, VisualMetaMap } from './protocol.js';
import { Seat } from './seat.js';
import { validateTeam } from './teams.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - read aloud/typed by hand
const CODE_LENGTH = 6;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ENDED_GRACE_MS = 2 * 60 * 1000;

export interface SeatInfo {
	name: string;
	team: PokemonSet[];
	visualMeta: VisualMetaMap;
	seatToken: string;
	seat: Seat;
}

export class Room {
	readonly code: string;
	readonly gen: SupportedGen;
	readonly format: string;
	phase: RoomPhase = 'waiting';
	engine: BattleEngine | null = null;
	readonly createdAt = Date.now();
	lastActivityAt = Date.now();
	readonly players: Partial<Record<SideID, SeatInfo>> = {};

	constructor(code: string, gen: SupportedGen) {
		this.code = code;
		this.gen = gen;
		this.format = formatFor(gen);
	}

	private touch(): void {
		this.lastActivityAt = Date.now();
	}

	isFull(): boolean {
		return !!this.players.p1 && !!this.players.p2;
	}

	isIdle(now: number): boolean {
		const timeout = this.phase === 'ended' ? ENDED_GRACE_MS : IDLE_TIMEOUT_MS;
		return now - this.lastActivityAt > timeout;
	}

	addPlayer(
		side: SideID,
		info: { name: string; team: PokemonSet[]; visualMeta: VisualMetaMap },
		transport: (message: ServerMessage) => void
	): SeatInfo {
		const seat = new Seat(side, this.format);
		// done first otherwise the joining player's own "room is now full" state would be sent which seat has nothing attached
		seat.attach(transport);
		const seatInfo: SeatInfo = { ...info, seatToken: randomUUID(), seat };
		this.players[side] = seatInfo;
		this.touch();
		this.tryStart();
		this.broadcastRoomState();
		return seatInfo;
	}

	private tryStart(): void {
		const { p1, p2 } = this.players;
		if (!p1 || !p2 || this.engine) return;

		this.phase = 'battle';
		this.engine = new BattleEngine();
		// Sprite resolution needs both players' visualMeta merged - a
		// Transform can turn a Pokemon into a copy of the OPPONENT's, whose
		// species id then only exists in the opponent's map (see view.ts's
		// spriteIdFor doc).
		const visualMeta: VisualMetaMap = { ...p1.visualMeta, ...p2.visualMeta };
		p1.seat.bindStream(this.engine.streams.p1, visualMeta);
		p2.seat.bindStream(this.engine.streams.p2, visualMeta);
		this.engine.start(this.format, { name: p1.name, team: p1.team }, { name: p2.name, team: p2.team });
		void this.watchForEnd();
	}

	/**
	 * Room-lifecycle-only win detection: sets phase to 'ended' (for
	 * broadcastRoomState and GC eligibility) via the omniscient stream. The
	 * actual per-seat `{t:'end', winner, view}` message is NOT sent from
	 * here - each Seat detects |win|/|tie| independently from its own
	 * stream and sends its own final view (see seat.ts). Duplicating that
	 * trivial name-comparison is deliberate: this consumer and each seat's
	 * pump are three independent async iterators over channels demuxed from
	 * the same underlying stream, with no guaranteed ordering between them,
	 * so this room-level watcher must not be the thing that triggers a
	 * seat's projection - it could fire before that seat's own pump has
	 * processed the very `|win|` chunk being projected.
	 *
	 * |win|USERNAME / |tie| (PROTOCOL.md) identify the winner by name, not
	 * by side - the sim protocol has no per-side "you won" line. If both
	 * seats share a display name the winner can't be disambiguated here,
	 * same as it can't be in the official client.
	 */
	private async watchForEnd(): Promise<void> {
		if (!this.engine) return;
		for await (const chunk of this.engine.streams.omniscient) {
			this.touch();
			for (const line of chunk.split('\n')) {
				if (line.startsWith('|win|') || line.startsWith('|tie|')) {
					this.phase = 'ended';
					this.touch();
					return;
				}
			}
		}
	}

	broadcastRoomState(): void {
		const message: ServerMessage = {
			t: 'roomState',
			phase: this.phase,
			players: { p1: this.players.p1?.name, p2: this.players.p2?.name },
		};
		this.players.p1?.seat.send(message);
		this.players.p2?.seat.send(message);
	}

	choose(side: SideID, rqid: number, choice: Choice): void {
		this.players[side]?.seat.choose(rqid, choice);
		this.touch();
	}

	destroy(): void {
		this.engine?.destroy();
	}
}

export type RoomError =
	| { code: 'room_not_found' }
	| { code: 'room_full' }
	| { code: 'invalid_seat_token' }
	| { code: 'team_invalid'; problems: string[] };

export class RoomRegistry {
	private readonly rooms = new Map<string, Room>();

	private generateCode(): string {
		let code: string;
		do {
			code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
		} while (this.rooms.has(code));
		return code;
	}

	create(
		gen: SupportedGen,
		name: string,
		team: PokemonSet[],
		visualMeta: VisualMetaMap,
		transport: (message: ServerMessage) => void
	): { room: Room; seatInfo: SeatInfo } | RoomError {
		const room = new Room(this.generateCode(), gen);
		const validation = validateTeam(room.format, team);
		if (!validation.valid) return { code: 'team_invalid', problems: validation.problems };

		const seatInfo = room.addPlayer('p1', { name, team, visualMeta }, transport);
		this.rooms.set(room.code, room);
		return { room, seatInfo };
	}

	join(
		code: string,
		name: string,
		team: PokemonSet[],
		visualMeta: VisualMetaMap,
		transport: (message: ServerMessage) => void
	): { room: Room; seatInfo: SeatInfo } | RoomError {
		const room = this.rooms.get(code.toUpperCase());
		if (!room) return { code: 'room_not_found' };
		if (room.isFull()) return { code: 'room_full' };

		const validation = validateTeam(room.format, team);
		if (!validation.valid) return { code: 'team_invalid', problems: validation.problems };

		const seatInfo = room.addPlayer('p2', { name, team, visualMeta }, transport);
		return { room, seatInfo };
	}

	resume(
		code: string,
		seatToken: string
	): { room: Room; side: SideID } | { code: 'room_not_found' } | { code: 'invalid_seat_token' } {
		const room = this.rooms.get(code.toUpperCase());
		if (!room) return { code: 'room_not_found' };

		for (const side of ['p1', 'p2'] as const) {
			if (room.players[side]?.seatToken === seatToken) return { room, side };
		}
		return { code: 'invalid_seat_token' };
	}

	sweep(now = Date.now()): number {
		let removed = 0;
		for (const [code, room] of this.rooms) {
			if (room.isIdle(now)) {
				room.destroy();
				this.rooms.delete(code);
				removed++;
			}
		}
		return removed;
	}

	get size(): number {
		return this.rooms.size;
	}
}
