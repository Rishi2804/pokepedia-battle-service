import { randomInt, randomUUID } from 'node:crypto';
import type { PokemonSet } from '@pkmn/sim';
import { BattleEngine } from './engine.js';
import { type BattleFormatKey, formatFor } from './formats.js';
import type { Choice, RoomPhase, ServerMessage, SideID, VisualMetaMap } from './protocol.js';
import { Seat } from './seat.js';
import { validateTeam } from './teams.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - read aloud/typed by hand
const CODE_LENGTH = 6;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ENDED_GRACE_MS = 2 * 60 * 1000;
/** How long a disconnected player's opponent waits before the battle is
 * auto-forfeited. Long enough to survive a page refresh or a brief network
 * blip, short enough that the other player isn't stuck staring at a dead
 * room. */
const DISCONNECT_GRACE_MS = 60 * 1000;

type Transport = (message: ServerMessage) => void;

export interface SeatInfo {
	name: string;
	team: PokemonSet[];
	visualMeta: VisualMetaMap;
	seatToken: string;
	seat: Seat;
	/** Kept alongside the seat (which only exposes attach()/detach(), not a
	 * getter) so a rematch can re-attach a fresh Seat to whatever transport
	 * this player is currently connected on. */
	transport: Transport;
}

export class Room {
	readonly code: string;
	readonly formatKey: BattleFormatKey;
	readonly format: string;
	phase: RoomPhase = 'waiting';
	engine: BattleEngine | null = null;
	readonly createdAt = Date.now();
	lastActivityAt = Date.now();
	readonly players: Partial<Record<SideID, SeatInfo>> = {};
	/** Set once both players are present (tryStart) and reused by rematch()
	 * and forfeit() - see tryStart's doc for why it has to be the merge of
	 * both sides' maps rather than just the owning seat's own. */
	private mergedVisualMeta: VisualMetaMap | null = null;
	private readonly disconnectTimers: Partial<Record<SideID, ReturnType<typeof setTimeout>>> = {};

	constructor(code: string, formatKey: BattleFormatKey) {
		this.code = code;
		this.formatKey = formatKey;
		this.format = formatFor(formatKey);
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

	/** Attaches (or re-attaches) a transport to whichever Seat currently
	 * occupies `side`, keeping SeatInfo.transport in sync so a later
	 * rematch() can re-attach a fresh Seat to the same connection without
	 * the caller having to track transports separately. Used for the
	 * initial join and for reattaching on resume - the resume path used to
	 * call seat.attach() directly, which left SeatInfo.transport pointing
	 * at a closed connection after a reconnect. */
	attachTransport(side: SideID, transport: Transport): void {
		const info = this.players[side];
		if (!info) return;
		info.transport = transport;
		info.seat.attach(transport);
	}

	addPlayer(
		side: SideID,
		info: { name: string; team: PokemonSet[]; visualMeta: VisualMetaMap },
		transport: Transport
	): SeatInfo {
		const seatInfo: SeatInfo = { ...info, seatToken: randomUUID(), seat: new Seat(side, this.format), transport };
		this.players[side] = seatInfo;
		// attach before touch/tryStart/broadcastRoomState - those can send
		// messages immediately, which would be lost if the transport wasn't
		// wired up yet.
		this.attachTransport(side, transport);
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
		this.mergedVisualMeta = visualMeta;
		p1.seat.bindStream(this.engine.streams.p1, visualMeta);
		p2.seat.bindStream(this.engine.streams.p2, visualMeta);
		this.engine.start(this.format, { name: p1.name, team: p1.team }, { name: p2.name, team: p2.team });
		void this.watchForEnd();
	}

	/** Same room, same two players/teams, a brand new engine and Seats. A
	 * Seat's @pkmn/client `Battle` accumulates state for exactly one
	 * battle's lifetime (turn count, fainted mons, ...), so a rematch needs
	 * fresh Seats rather than resetting the old ones in place - simpler and
	 * safer than trying to reuse @pkmn/client state across a restart. */
	rematch(): { ok: true } | { ok: false; reason: string } {
		const { p1, p2 } = this.players;
		if (!p1 || !p2) return { ok: false, reason: 'Your opponent is not connected.' };
		if (this.phase !== 'ended') return { ok: false, reason: 'The battle has not ended yet.' };

		this.engine?.destroy();
		this.engine = null;
		p1.seat = new Seat('p1', this.format);
		p2.seat = new Seat('p2', this.format);
		this.attachTransport('p1', p1.transport);
		this.attachTransport('p2', p2.transport);

		this.touch();
		this.tryStart();
		return { ok: true };
	}

	/** Starts (or restarts) the forfeit clock for a disconnected seat. A
	 * clean detach (page refresh, brief network drop) is expected to be
	 * followed by a resume within the grace window - handleReconnect
	 * cancels the clock; if it fires anyway, the other player wins. */
	handleDisconnect(side: SideID): void {
		this.players[side]?.seat.detach();
		this.touch();
		if (this.phase !== 'battle') return;
		this.clearDisconnectTimer(side);
		const timer = setTimeout(() => this.forfeit(side), DISCONNECT_GRACE_MS);
		timer.unref();
		this.disconnectTimers[side] = timer;
	}

	handleReconnect(side: SideID): void {
		this.clearDisconnectTimer(side);
	}

	private clearDisconnectTimer(side: SideID): void {
		const timer = this.disconnectTimers[side];
		if (timer === undefined) return;
		clearTimeout(timer);
		delete this.disconnectTimers[side];
	}

	private forfeit(disconnectedSide: SideID): void {
		// Already ended for real (or somehow reconnected without the timer
		// getting cancelled) - don't clobber a real result.
		if (this.phase !== 'battle') return;
		delete this.disconnectTimers[disconnectedSide];
		this.phase = 'ended';
		this.touch();

		const winnerSide: SideID = disconnectedSide === 'p1' ? 'p2' : 'p1';
		const loserName = this.players[disconnectedSide]?.name ?? 'Your opponent';
		const message = `${loserName} disconnected and forfeited the battle.`;
		const visualMeta = this.mergedVisualMeta ?? {};
		this.players.p1?.seat.forceEnd(winnerSide, visualMeta, message);
		this.players.p2?.seat.forceEnd(winnerSide, visualMeta, message);
		this.broadcastRoomState();
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
		this.clearDisconnectTimer('p1');
		this.clearDisconnectTimer('p2');
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
		formatKey: BattleFormatKey,
		name: string,
		team: PokemonSet[],
		visualMeta: VisualMetaMap,
		transport: (message: ServerMessage) => void
	): { room: Room; seatInfo: SeatInfo } | RoomError {
		const room = new Room(this.generateCode(), formatKey);
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
