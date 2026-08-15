import type { PokemonSet } from '@pkmn/sim';
import type { SupportedGen } from './formats.js';

/**
 * Phase 1 envelope: the server plays correct battles and relays each seat's
 * raw per-seat sim protocol lines verbatim. There is no BattleView yet -
 * Phase 2 replaces the `update` message's `lines` with a projected
 * `{log, view}` pair (see the plan's Phase 2) without changing anything
 * else in this file's shape.
 */

export type SideID = 'p1' | 'p2';
export type RoomPhase = 'waiting' | 'validating' | 'battle' | 'ended';

export interface VisualMeta {
	pokemonId: number;
	shiny: boolean;
	female: boolean;
}

/** Keyed by Showdown species id (toShowdownId(slug), lowercased/no punctuation). */
export type VisualMetaMap = Record<string, VisualMeta>;

export type ClientMessage =
	| { t: 'create'; gen: SupportedGen; name: string; team: PokemonSet[]; visualMeta: VisualMetaMap }
	| { t: 'join'; code: string; name: string; team: PokemonSet[]; visualMeta: VisualMetaMap }
	| { t: 'resume'; code: string; seatToken: string }
	| { t: 'choose'; choice: string }
	| { t: 'leave' }
	| { t: 'rematch' };

// 'created' and 'joined' are separate discriminated-union members, not one
// member with a `t: 'created' | 'joined'` field - the latter breaks
// `Extract<ServerMessage, {t: 'created'}>` (and TestClient.waitFor's use of
// it) because a value typed `t: 'created' | 'joined'` isn't assignable to
// `t: 'created'` alone, so Extract resolves to `never`.
export type ServerMessage =
	| { t: 'created'; code: string; seat: SideID; seatToken: string; format: string }
	| { t: 'joined'; code: string; seat: SideID; seatToken: string; format: string }
	| { t: 'roomState'; phase: RoomPhase; players: Partial<Record<SideID, string>> }
	| { t: 'update'; lines: string[] }
	| { t: 'error'; code: ErrorCode; message: string; problems?: string[] }
	| { t: 'end'; winner: SideID | 'tie' | null };

export type ErrorCode =
	| 'invalid_message'
	| 'room_not_found'
	| 'room_full'
	| 'invalid_seat_token'
	| 'gen_mismatch'
	| 'team_invalid'
	| 'not_your_turn'
	| 'internal_error';
