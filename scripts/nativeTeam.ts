import { Dex, type PokemonSet } from '@pkmn/sim';
import type { BattleFormatKey } from '../src/formats.js';
import type { BattleTeamMember, StatSpread } from '../src/protocol.js';
import type { VersionGroup } from '../src/versionRules.js';

/**
 * Lets the scripts keep generating teams with Showdown's random-battle
 * generator while sending the server the native PokePedia payload it now
 * expects - the reverse of src/teamConvert.ts. A representative version group
 * per format key; null is a Home team.
 */
const VERSION_GROUP_FOR: Record<BattleFormatKey, VersionGroup | null> = {
	1: 'RED_BLUE',
	2: 'GOLD_SILVER',
	3: 'EMERALD',
	4: 'PLATINUM',
	5: 'BLACK_2_WHITE_2',
	6: 'X_Y',
	7: 'ULTRA_SUN_ULTRA_MOON',
	8: 'SWORD_SHIELD',
	9: 'SCARLET_VIOLET',
	nationaldex: null,
	legendsza: 'LEGENDS_ZA',
};

function mapSpread(spread: Partial<StatSpread>, fallback: number, convert: (n: number) => number): StatSpread {
	const get = (stat: keyof StatSpread) => convert(spread[stat] ?? fallback);
	return { hp: get('hp'), atk: get('atk'), def: get('def'), spa: get('spa'), spd: get('spd'), spe: get('spe') };
}

function toMember(set: PokemonSet, formatKey: BattleFormatKey): BattleTeamMember {
	const oldGen = formatKey === 1 || formatKey === 2;
	const species = Dex.species.get(set.species);
	return {
		pokemonId: species.num,
		slug: species.id,
		showdownId: species.id,
		nickname: set.name && set.name !== set.species ? set.name : null,
		shiny: !!set.shiny,
		gender: set.gender === 'M' ? 'male' : set.gender === 'F' ? 'female' : 'genderless',
		ability: set.ability || null,
		moves: set.moves,
		level: set.level ?? 100,
		nature: (set.nature || 'Hardy').toLowerCase(),
		item: set.item ? Dex.items.get(set.item).id : null,
		// Gens 1-2 store Stat Exp and DVs; everything else already matches.
		evs: mapSpread(set.evs ?? {}, 0, n => (oldGen ? n * n : n)),
		ivs: mapSpread(set.ivs ?? {}, 31, n => (oldGen ? Math.floor(n / 2) : n)),
		happiness: set.happiness ?? 255,
		teraType: set.teraType ? set.teraType.toUpperCase() : null,
		dynamaxLevel: set.dynamaxLevel ?? 10,
		gigantamax: !!set.gigantamax,
	};
}

export function toNativeTeam(formatKey: BattleFormatKey, team: PokemonSet[]): { versionGroup: VersionGroup | null; team: BattleTeamMember[] } {
	return { versionGroup: VERSION_GROUP_FOR[formatKey], team: team.map(set => toMember(set, formatKey)) };
}
