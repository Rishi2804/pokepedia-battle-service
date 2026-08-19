import type { Battle, Pokemon } from '@pkmn/client';
import type { Protocol } from '@pkmn/protocol';
import type {
	ActiveView,
	BattlePhase,
	BattleView,
	FieldView,
	LogKind,
	Named,
	RequestMoveView,
	RequestSwitchView,
	RequestView,
	SideConditionView,
	SideID,
	SideView,
	SlotView,
	VisualMetaMap,
} from './protocol.js';

/** Same normalization Showdown's own `toID` uses (sim/dex-data.ts) and what
 * the frontend's `toShowdownId(slug)` produces - lowercase, alphanumeric
 * only. Reimplemented locally rather than imported since it's one line and
 * none of our deps export it as a public API. */
function toId(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * @pkmn/protocol's `Request.ActivePokemon.moves[]` type declares a `name`
 * field, but the sim actually emits `move` (pokemon-showdown sim/pokemon.ts
 * `getMoveRequestData`: `move: move.name`) - verified against a live battle
 * during implementation. Likewise `TeamRequest` types `maxTeamSize`, but the
 * sim emits `maxChosenTeamSize` (sim/battle.ts `getRequests`). Same again for
 * Z-moves: the type says `zMoves`, the sim emits `canZMove` (sim/pokemon.ts
 * `getMoveRequestData`: `data.canZMove = canZMove`) - so reading `zMoves` here
 * silently never matched and the Z-Move button could never appear. That went
 * unnoticed until National Dex made Z-Crystals equippable at all. All three are
 * @pkmn/protocol type/reality mismatches, not something we got wrong; this
 * is where we read the real field names back out through a cast.
 */
interface RawRequestMove {
	move: string;
	id: string;
	pp?: number;
	maxpp?: number;
	disabled?: boolean;
}
interface RawTeamRequest {
	maxChosenTeamSize?: number;
}
interface RawActiveZMove {
	canZMove?: ({ move: string; target: string } | null)[];
}

/**
 * The raw sim `|request|` JSON has neither a `requestType` discriminant nor
 * pre-parsed per-Pokemon health/details - both @pkmn/client's Battle.update
 * and this module's projection expect them already present. This mirrors
 * pokemon-showdown-client's `BattleChoiceBuilder.fixRequest` (the derivation
 * is a protocol quirk, not something either @pkmn/client or @pkmn/view do
 * for you - verified against both packages' source during implementation).
 */
export function fixRequest(request: any, protocol: typeof Protocol): Protocol.Request {
	if (!request.requestType) {
		request.requestType = 'move';
		if (request.forceSwitch) request.requestType = 'switch';
		else if (request.teamPreview) request.requestType = 'team';
		else if (request.wait) request.requestType = 'wait';
	}
	if (request.side) {
		for (const p of request.side.pokemon) {
			protocol.parseDetails(p.ident.slice(4), p.ident, p.details, p);
			protocol.parseHealth(p.condition, p);
		}
	}
	return request as Protocol.Request;
}

/**
 * Resolves a live Pokemon's current species (which can change mid-battle -
 * Transform, Mega Evolution, Zygarde, Terastallize) to a PokePedia sprite
 * id. Looks across BOTH players' visualMeta, not just the owning side's -
 * Transform can turn your own Pokemon into a copy of the opponent's, whose
 * id then only exists in the opponent's map (confirmed during
 * implementation: a Ditto that transformed into the foe's Rhyperior needs
 * the foe's visualMeta entry to render correctly). Falls back to the
 * national dex number for an untransformed/unrevealed species, which covers
 * base forms but not every alt forme - the UI's final fallback is a
 * placeholder tile.
 */
function spriteIdFor(speciesId: string, nationalDexNum: number | undefined, visualMeta: VisualMetaMap): number | null {
	const meta = visualMeta[speciesId];
	if (meta) return meta.pokemonId;
	if (nationalDexNum && nationalDexNum > 0) return nationalDexNum;
	return null;
}

function optionalNamed(effect: { id: string; name: string }): Named | null {
	return effect.name ? { id: effect.id, name: effect.name } : null;
}

/**
 * `@pkmn/client`'s Handler resolves an item revealed via a `[from] item: X`
 * kwarg (e.g. Life Orb recoil) by looking it up in the generic "conditions"
 * table (`battle.get('conditions', kwArgs.from)`), which correctly returns
 * `kind: 'Item'` but with the item's *namespaced* effect id
 * (`"item:lifeorb"`, not `"lifeorb"`) - and then assigns that whole string
 * to `Pokemon.item`. Looking that back up in the real items table then
 * fails and falls back to displaying the raw id. Verified against a live
 * battle during implementation (a Life Orb revealed via recoil rendered as
 * "item:lifeorb"). Stripped defensively wherever an id is read back out,
 * since the same "conditions" fallback pattern could plausibly leak into
 * other fields (ability) the same way.
 */
function stripEffectNamespace(id: string | undefined | null): string {
	if (!id) return '';
	const colon = id.indexOf(':');
	return colon === -1 ? id : id.slice(colon + 1);
}

function humanNamed(display: string): Named {
	return { id: toId(display), name: display };
}

function hpColorFor(hpPercent: number): SlotView['hpColor'] {
	if (hpPercent > 50) return 'green';
	if (hpPercent > 20) return 'yellow';
	return 'red';
}

function projectField(battle: Battle): FieldView {
	const field = battle.field;
	return {
		weather: field.weather ? humanNamed(field.weather) : null,
		terrain: field.terrain ? humanNamed(field.terrain) : null,
		pseudoWeather: Object.keys(field.pseudoWeather).map(id => optionalNamed(battle.get('conditions', id))).filter((n): n is Named => n !== null),
	};
}

function projectSideConditions(sideConditions: Record<string, { name: string; level: number }>): SideConditionView[] {
	return Object.entries(sideConditions).map(([id, condition]) => ({ id, name: condition.name, level: condition.level }));
}

function projectSlot(battle: Battle, p: Pokemon, visualMeta: VisualMetaMap): SlotView {
	const hpPercent = p.maxhp > 0 ? Math.round((p.hp / p.maxhp) * 100) : 0;
	// `p.species` is a dex lookup on speciesForme and is typed non-null, but it
	// resolves to undefined for any species the dex's `exists` filter excludes
	// (see seat.ts's permissiveExists). That filter is now permissive enough
	// that this shouldn't happen - but this runs inside an async pump, so an
	// unguarded throw here kills the whole server process and every other room
	// on it. A missing sprite is a far better failure than that.
	const species = p.species as typeof p.species | undefined;
	return {
		ident: p.ident,
		speciesForme: p.speciesForme,
		name: p.name || p.speciesForme,
		spriteId: species ? spriteIdFor(species.id, species.num, visualMeta) : null,
		shiny: p.shiny,
		female: p.gender === 'F',
		level: p.level,
		gender: p.gender,
		hp: p.hp,
		maxhp: p.maxhp,
		hpPercent,
		hpColor: hpColorFor(hpPercent),
		status: p.status ?? null,
		fainted: p.fainted,
		types: p.types as string[],
		item: optionalNamed(battle.get('items', stripEffectNamespace(p.item))),
		ability: optionalNamed(battle.get('abilities', stripEffectNamespace(p.ability))),
		terastallized: p.terastallized ?? null,
	};
}

function projectActive(battle: Battle, p: Pokemon, visualMeta: VisualMetaMap): ActiveView {
	return {
		...projectSlot(battle, p, visualMeta),
		boosts: p.boosts,
		volatiles: Object.keys(p.volatiles).map(id => optionalNamed(battle.get('conditions', id))).filter((n): n is Named => n !== null),
	};
}

function projectSide(battle: Battle, side: Battle['p1'], visualMeta: VisualMetaMap): SideView {
	return {
		name: side.name,
		teamSize: side.totalPokemon,
		active: side.active[0] ? projectActive(battle, side.active[0], visualMeta) : null,
		team: side.team.map(p => projectSlot(battle, p, visualMeta)),
		conditions: projectSideConditions(side.sideConditions as unknown as Record<string, { name: string; level: number }>),
	};
}

function projectRequest(battle: Battle, request: Protocol.Request | undefined, visualMeta: VisualMetaMap): RequestView | null {
	if (!request) return null;

	const moves: RequestMoveView[] = [];
	let trapped = false;
	let forceSwitch = false;
	let teamPreviewSize: number | undefined;
	const special: RequestView['special'] = {};

	if (request.requestType === 'move') {
		const active = request.active[0];
		if (active) {
			(active.moves as unknown as RawRequestMove[]).forEach((m, i) => {
				const data = battle.get('moves', m.id);
				moves.push({
					index: i + 1,
					id: m.id,
					name: m.move,
					type: 'type' in data ? (data.type as string) : '',
					category: 'category' in data ? (data.category as string) : '',
					pp: m.pp ?? 0,
					maxpp: m.maxpp ?? 0,
					disabled: !!m.disabled,
				});
			});
			trapped = !!active.trapped;
			if (active.canTerastallize) special.tera = { type: active.canTerastallize };
			if (active.canMegaEvo) special.mega = true;
			if (active.canDynamax) special.dynamax = true;
			if ((active as unknown as RawActiveZMove).canZMove?.some(z => !!z)) special.zmove = true;
		}
	} else if (request.requestType === 'switch') {
		forceSwitch = request.forceSwitch?.[0] ?? false;
	} else if (request.requestType === 'team') {
		teamPreviewSize = (request as unknown as RawTeamRequest).maxChosenTeamSize;
	}

	const canSwitch: RequestSwitchView[] = (request.side?.pokemon ?? []).map((p: any, i) => ({
		index: i + 1,
		name: p.name as string,
		spriteId: spriteIdFor(toId(p.speciesForme as string), undefined, visualMeta),
		fainted: !!p.fainted,
		active: !!p.active,
	}));

	// The wire's requestType is 'team' for team preview; the public
	// RequestView.kind spells it out as 'teampreview' for clarity.
	const kind = request.requestType === 'team' ? 'teampreview' : request.requestType;

	return { rqid: request.rqid, kind, moves, canSwitch, trapped, forceSwitch, teamPreviewSize, special };
}

export function project(
	battle: Battle,
	seat: SideID,
	format: string,
	winner: SideID | 'tie' | null,
	visualMeta: VisualMetaMap
): BattleView {
	const me = battle[seat];
	const foe = battle[seat === 'p1' ? 'p2' : 'p1'];

	const relativeWinner = winner === null ? null : winner === 'tie' ? 'tie' : winner === seat ? 'me' : 'foe';
	const phase: BattlePhase = winner !== null ? 'ended' : battle.request?.requestType === 'team' ? 'teampreview' : 'battle';

	return {
		seat,
		phase,
		turn: battle.turn,
		gen: battle.gen.num,
		format,
		field: projectField(battle),
		me: projectSide(battle, me, visualMeta),
		foe: projectSide(battle, foe, visualMeta),
		winner: relativeWinner,
		request: winner !== null ? null : projectRequest(battle, battle.request, visualMeta),
	};
}

/**
 * Cleans @pkmn/view's LogFormatter output for plain-text rendering: `**X**`
 * bold markers are markdown for a UI we don't have, and `||exact||percent||`
 * is a spectator-log spoiler-tooltip convention (see LogFormatter.formatHTML)
 * that doesn't apply to a private per-seat log - both are stripped down to
 * their plain visible form. A single formatted block can contain several
 * newline-joined sentences (e.g. a move line plus its effectiveness line),
 * which become separate log entries.
 *
 * Also strips a stray literal "undefined" - some of LogFormatter's generic
 * templates (e.g. the `-end` fallback "[POKEMON] was freed from [EFFECT]!")
 * don't have a specific display-name entry for every effect they can be
 * asked to name (verified live: Kingambit's numbered "Fallen" volatile
 * renders as "freed from fallenundefined!"). This is an upstream
 * @pkmn/view gap, not a state bug - the underlying BattleView stays
 * correct - so it's cleaned here as a general safety net rather than
 * chased into that template table for one obscure effect.
 */
export function cleanLogText(text: string): string[] {
	return text
		.split('\n')
		.map(line =>
			line
				.replace(/\|\|([^|]*)\|\|([^|]*)\|\|/g, '$2')
				.replace(/\*\*/g, '')
				.replace(/undefined/g, '')
				.trim()
		)
		.filter(line => line.length > 0);
}

/** Maps a raw protocol command (`args[0]` from `Protocol.parseBattleLine`,
 * e.g. `'-damage'`, `'switch'`, `'faint'`) to a coarse category for the log
 * UI to color by. Deliberately keyed off the protocol event, not the
 * formatted English sentence - text like "Pikachu used Thunderbolt!" vs
 * "It's super effective!" both come from a `move` event's multi-line
 * formatText output, so classifying by wording would be guesswork where
 * classifying by the event that produced it isn't. */
export function classifyLine(cmd: string): LogKind {
	switch (cmd) {
		case 'turn':
			return 'turn';
		case 'move':
			return 'move';
		case '-damage':
			return 'damage';
		case '-heal':
		case '-sethp':
			return 'heal';
		case 'faint':
			return 'faint';
		case '-status':
		case '-curestatus':
		case '-cureteam':
			return 'status';
		case '-boost':
		case '-unboost':
		case '-setboost':
		case '-clearboost':
		case '-clearallboost':
		case '-invertboost':
		case '-clearpositiveboost':
		case '-clearnegativeboost':
		case '-swapboost':
		case '-copyboost':
			return 'boost';
		case '-weather':
		case '-fieldstart':
		case '-fieldend':
		case '-sidestart':
		case '-sideend':
			return 'weather';
		case 'switch':
		case 'drag':
		case 'replace':
		case 'swap':
			return 'switch';
		case '-ability':
		case '-endability':
			return 'ability';
		case '-item':
		case '-enditem':
			return 'item';
		case 'win':
		case 'tie':
			return 'win';
		default:
			return 'system';
	}
}
