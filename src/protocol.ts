import type { PokemonSet } from '@pkmn/sim';
import type { BattleFormatKey } from './formats.js';

export type SideID = 'p1' | 'p2';
export type RoomPhase = 'waiting' | 'validating' | 'battle' | 'ended';

export interface VisualMeta {
	pokemonId: number;
	shiny: boolean;
	female: boolean;
}

/** Keyed by Showdown species id (toShowdownId(slug), lowercased/no punctuation). */
export type VisualMetaMap = Record<string, VisualMeta>;

/** A dex object (move/item/ability/type/weather/...) reduced to what the UI
 * renders - id for icons/lookups, name for display. Resolved server-side so
 * the browser never needs its own dex. */
export interface Named {
	id: string;
	name: string;
}

export type BattlePhase = 'teampreview' | 'battle' | 'ended';

export interface FieldView {
	weather: Named | null;
	terrain: Named | null;
	pseudoWeather: Named[];
}

export interface SideConditionView {
	id: string;
	name: string;
	level: number;
}

export type StatusName = 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox';

export interface SlotView {
	ident: string;
	speciesForme: string;
	/** Nickname if set, otherwise species name. */
	name: string;
	spriteId: number | null;
	shiny: boolean;
	female: boolean;
	level: number;
	gender: 'M' | 'F' | 'N';
	hp: number;
	maxhp: number;
	hpPercent: number;
	hpColor: 'green' | 'yellow' | 'red';
	status: StatusName | null;
	fainted: boolean;
	/** Current types, post-retyping (Soak, Reflect Type, Terastallize, ...). */
	types: string[];
	/** Revealed only - null means "not (yet) known to this seat." */
	item: Named | null;
	ability: Named | null;
	terastallized: string | null;
}

export type BoostID = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';

export interface ActiveView extends SlotView {
	boosts: Partial<Record<BoostID, number>>;
	volatiles: Named[];
}

export interface SideView {
	name: string;
	teamSize: number;
	active: ActiveView | null;
	/** Foe sides only ever contain revealed slots. */
	team: SlotView[];
	conditions: SideConditionView[];
}

export interface RequestMoveView {
	index: number;
	id: string;
	name: string;
	type: string;
	category: string;
	pp: number;
	maxpp: number;
	disabled: boolean;
}

export interface RequestSwitchView {
	index: number;
	name: string;
	spriteId: number | null;
	fainted: boolean;
	active: boolean;
}

export interface RequestView {
	rqid: number;
	kind: 'move' | 'switch' | 'teampreview' | 'wait';
	moves: RequestMoveView[];
	canSwitch: RequestSwitchView[];
	trapped: boolean;
	forceSwitch: boolean;
	teamPreviewSize?: number;
	special: {
		tera?: { type: string };
		mega?: boolean;
		zmove?: boolean;
		dynamax?: boolean;
	};
}

/** Derived server-side from the raw protocol event (see view.ts's
 * classifyLine), not sniffed from the formatted English text - the text
 * alone doesn't reliably say what kind of event produced it. */
export type LogKind =
	| 'turn' | 'move' | 'damage' | 'heal' | 'faint' | 'status'
	| 'boost' | 'weather' | 'switch' | 'ability' | 'item' | 'win' | 'system';

export interface LogEntry {
	text: string;
	kind: LogKind;
}

export interface BattleView {
	seat: SideID;
	phase: BattlePhase;
	turn: number;
	gen: number;
	format: string;
	field: FieldView;
	me: SideView;
	foe: SideView;
	winner: 'me' | 'foe' | 'tie' | null;
	/** null means it isn't this seat's turn to choose anything. */
	request: RequestView | null;
}

/** What the client sends back for a |request| - built from a structured
 * pick, not free text, so the server never has to parse a choice string a
 * human typed. src/choices.ts turns this into the real sim choice string. */
export type Choice =
	| { kind: 'move'; index: number; tera?: boolean; mega?: boolean; zmove?: boolean; dynamax?: boolean }
	| { kind: 'switch'; index: number }
	| { kind: 'team'; order: number[] }
	| { kind: 'default' }
	| { kind: 'undo' };

export type ClientMessage =
	// `formatKey` is what the room should play under (a gen, or 'nationaldex'),
	// not the resolved Showdown format id - that comes back as `format` below.
	| { t: 'create'; formatKey: BattleFormatKey; name: string; team: PokemonSet[]; visualMeta: VisualMetaMap }
	| { t: 'join'; code: string; name: string; team: PokemonSet[]; visualMeta: VisualMetaMap }
	| { t: 'resume'; code: string; seatToken: string }
	| { t: 'choose'; rqid: number; choice: Choice }
	| { t: 'leave' }
	| { t: 'rematch' };

// 'created' and 'joined' are separate discriminated-union members, not one
// member with a `t: 'created' | 'joined'` field - the latter breaks
// `Extract<ServerMessage, {t: 'created'}>` because a value typed
// `t: 'created' | 'joined'` isn't assignable to `t: 'created'` alone, so
// Extract resolves to `never`.
export type ServerMessage =
	| { t: 'created'; code: string; seat: SideID; seatToken: string; format: string }
	| { t: 'joined'; code: string; seat: SideID; seatToken: string; format: string }
	| { t: 'roomState'; phase: RoomPhase; players: Partial<Record<SideID, string>> }
	| { t: 'update'; log: LogEntry[]; view: BattleView }
	/** Raw per-seat sim protocol lines, gated behind a dev flag. Not part of
	 * the contract the UI renders against - for inspecting/replaying a
	 * battle without a second protocol implementation. */
	| { t: 'debug'; lines: string[] }
	| { t: 'error'; code: ErrorCode; message: string; problems?: string[] }
	| { t: 'end'; winner: SideID | 'tie' | null; log: LogEntry[]; view: BattleView };

export type ErrorCode =
	| 'invalid_message'
	| 'room_not_found'
	| 'room_full'
	| 'invalid_seat_token'
	| 'gen_mismatch'
	| 'team_invalid'
	| 'not_your_turn'
	| 'invalid_choice'
	| 'rematch_unavailable'
	| 'internal_error';
