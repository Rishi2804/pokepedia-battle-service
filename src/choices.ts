import type { Battle } from '@pkmn/client';
import type { Choice } from './protocol.js';

export type ChoiceResolution = { ok: true; choiceString: string } | { ok: false; message: string };

/** @pkmn/protocol's Request.ActivePokemon.moves[] type declares a `name`
 * field, but the sim actually emits `move` - same mismatch documented in
 * view.ts's RawRequestMove, verified against a live battle. */
interface RawRequestMove {
	move: string;
	disabled?: boolean;
}

/**
 * Turns a structured client Choice into the real sim choice string
 * (`sim/SIM-PROTOCOL.md` "Possible choices"), validating it against the
 * live (already `fixRequest`-normalized, see view.ts) request first so a
 * bad pick gets an immediate, specific rejection instead of a round trip
 * through the engine's own `|error|[Invalid choice]`.
 *
 * Deliberately hand-rolled rather than built on @pkmn/view's ChoiceBuilder:
 * that class exists to parse free text a human typed (e.g. "move thunder
 * mega") and accumulate multi-slot doubles/triples choices one click at a
 * time. We already receive a single, fully-structured choice, and Anything
 * Goes is singles-only, so there's no free text to parse and no multi-slot
 * accumulation to track - just bounds/legality checks and a format() call.
 */
export function resolveChoice(battle: Battle, rqid: number, choice: Choice): ChoiceResolution {
	const request = battle.request;
	if (!request) return { ok: false, message: "It's not your turn to choose anything." };
	if (request.rqid !== rqid) return { ok: false, message: `Stale request (current rqid is ${request.rqid}).` };

	switch (choice.kind) {
		case 'default':
			return { ok: true, choiceString: 'default' };
		case 'undo':
			return { ok: true, choiceString: 'undo' };

		case 'move': {
			if (request.requestType !== 'move') return { ok: false, message: 'You must switch, not move.' };
			const active = request.active[0];
			if (!active) return { ok: false, message: 'No active Pokemon to move with.' };
			const move = active.moves[choice.index - 1] as unknown as RawRequestMove | undefined;
			if (!move) return { ok: false, message: `No move at index ${choice.index}.` };
			if (move.disabled) return { ok: false, message: `${move.move} is disabled.` };

			let choiceString = `move ${choice.index}`;
			if (choice.tera) {
				if (!active.canTerastallize) return { ok: false, message: 'Terastallization is not available.' };
				choiceString += ' terastallize';
			}
			if (choice.mega) {
				if (!active.canMegaEvo) return { ok: false, message: 'Mega Evolution is not available.' };
				choiceString += ' mega';
			}
			if (choice.zmove) {
				if (!active.zMoves?.[choice.index - 1]) return { ok: false, message: 'Z-Move is not available for that move.' };
				choiceString += ' zmove';
			}
			if (choice.dynamax) {
				if (!active.canDynamax) return { ok: false, message: 'Dynamax is not available.' };
				choiceString += ' max';
			}
			return { ok: true, choiceString };
		}

		case 'switch': {
			if (request.requestType !== 'move' && request.requestType !== 'switch') {
				return { ok: false, message: 'You cannot switch right now.' };
			}
			if (request.requestType === 'move' && request.active[0]?.trapped) {
				return { ok: false, message: 'Your active Pokemon is trapped.' };
			}
			const target = request.side.pokemon[choice.index - 1];
			if (!target) return { ok: false, message: `No Pokemon at index ${choice.index}.` };
			if (target.fainted) return { ok: false, message: `${target.name} has fainted.` };
			if (target.active) return { ok: false, message: `${target.name} is already active.` };
			return { ok: true, choiceString: `switch ${choice.index}` };
		}

		case 'team': {
			if (request.requestType !== 'team') return { ok: false, message: 'Team preview is not active.' };
			if (choice.order.length === 0) return { ok: false, message: 'Team order cannot be empty.' };
			const size = request.side.pokemon.length;
			const seen = new Set<number>();
			for (const index of choice.order) {
				if (index < 1 || index > size || seen.has(index)) {
					return { ok: false, message: `Invalid team order (bad or repeated index ${index}).` };
				}
				seen.add(index);
			}
			return { ok: true, choiceString: `team ${choice.order.join('')}` };
		}
	}
}
