import { Dex, type PokemonSet, type Species } from '@pkmn/sim';
import type { BattleTeamMember, StatSpread, VisualMetaMap } from './protocol.js';
import { showdownIdFromSlug } from './speciesIds.js';
import { type ConversionRules, rulesFor, type VersionGroup } from './versionRules.js';

export type TeamConversion =
	| { ok: true; rules: ConversionRules; team: PokemonSet[]; visualMeta: VisualMetaMap }
	| { ok: false; problems: string[] };

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;

/** Gens 1-2 store Stat Exp (0-65535). Showdown takes EVs on the modern scale
 * and squares them back internally, so sqrt keeps the competitive effect
 * (sqrt(65535) is about 256, near the 252 cap). */
function statExpToEv(statExp: number): number {
	return Math.min(252, Math.round(Math.sqrt(statExp)));
}

/** Gens 1-2 store DVs (0-15). Showdown takes IVs and halves them back. */
function dvToIv(dv: number): number {
	return dv * 2;
}

function mapSpread(spread: StatSpread, convert: (n: number) => number): StatSpread {
	const out = {} as StatSpread;
	for (const stat of STAT_KEYS) out[stat] = convert(spread[stat]);
	return out;
}

function showdownGender(gender: BattleTeamMember['gender']): string {
	if (gender === 'male') return 'M';
	if (gender === 'female') return 'F';
	return '';
}

interface ResolvedSpecies {
	/** The species actually submitted - never a battle-only forme. */
	species: Species;
	/** Set when the picked forme is only reachable by holding an item
	 * (Mega Stone, Primal Orb, Rusted Sword, ...). */
	requiredItem?: string;
	gigantamax: boolean;
}

/**
 * A battle-only forme (Mega, Primal, Crowned, Zen, Gmax, ...) can never be a
 * submitted species - only its base species can, plus the item or flag that
 * reaches the forme. The sim's own `battleOnly` field marks these (and derives
 * it for Mega/Primal formes); Gmax formes only carry `changesFrom`. Where a
 * forme has more than one base (Zygarde-Complete, Necrozma-Ultra), the first
 * is used.
 */
function resolveSpecies(slug: string): ResolvedSpecies | null {
	const picked = Dex.species.get(showdownIdFromSlug(slug));
	if (!picked.exists) return null;

	const isGmax = picked.forme.endsWith('Gmax');
	const base = picked.battleOnly ?? (isGmax ? picked.changesFrom : undefined);
	if (!base) return { species: picked, gigantamax: false };

	let baseSpecies = Dex.species.get(Array.isArray(base) ? base[0] : base);
	// Floette-Mega comes from Floette-Eternal and Mimikyu-Busted-Totem from
	// Mimikyu-Totem, neither of which any format accepts - submit their own
	// base species instead.
	if (baseSpecies.natDexTier === 'Illegal') baseSpecies = Dex.species.get(baseSpecies.baseSpecies);
	if (!baseSpecies.exists) return null;
	const requiredItem = picked.requiredItem ?? picked.requiredItems?.[0];
	return { species: baseSpecies, requiredItem: requiredItem ? Dex.items.get(requiredItem).name : undefined, gigantamax: isGmax };
}

function convertMember(member: BattleTeamMember, rules: ConversionRules, problems: string[]): PokemonSet | null {
	const resolved = resolveSpecies(member.slug);
	if (!resolved) {
		problems.push(`Unknown Pokemon "${member.slug}".`);
		return null;
	}
	const { species } = resolved;

	let item = resolved.requiredItem ?? '';
	if (!item && member.item) {
		const dexItem = Dex.items.get(member.item);
		if (dexItem.exists) item = dexItem.name;
		else problems.push(`${species.name}: unknown item "${member.item}".`);
	}

	// The validator doesn't fill in a blank ability itself (it rejects the set),
	// and several version groups never show an ability picker, so fall back to
	// the species' first ability - what Showdown's own team builder defaults to.
	const ability = member.ability || species.abilities[0];

	const evs = rules.statExp ? mapSpread(member.evs, statExpToEv) : { ...member.evs };
	const ivs = rules.dvs ? mapSpread(member.ivs, dvToIv) : { ...member.ivs };
	// Gens 1-2 have one Special stat, which the team builder edits as SpA.
	// Showdown validates SpA and SpD as the same stat there, so mirror it.
	if (rules.statExp) {
		evs.spd = evs.spa;
		ivs.spd = ivs.spa;
	}

	const set: PokemonSet = {
		name: member.nickname ?? species.name,
		species: species.name,
		item,
		ability,
		moves: member.moves,
		nature: Dex.natures.get(member.nature).name,
		gender: showdownGender(member.gender),
		evs,
		ivs,
		level: member.level,
		shiny: member.shiny,
	};

	if (rules.happiness) set.happiness = member.happiness;
	if (rules.hiddenPower && member.moves.some(m => Dex.moves.get(m).id === 'hiddenpower')) {
		set.hpType = Dex.forGen(rules.dvs ? 2 : 9).getHiddenPower(ivs).type;
	}
	if (rules.tera && member.teraType) set.teraType = Dex.types.get(member.teraType).name;
	if (rules.dynamax) {
		set.dynamaxLevel = member.dynamaxLevel;
		set.gigantamax = member.gigantamax || resolved.gigantamax;
	}
	return set;
}

/**
 * Turns a PokePedia team into Showdown sets for its version group's format,
 * plus the sprite map the battle view uses to show PokePedia's HOME images.
 * The sprite map is keyed by the picked forme's Showdown id, so a team member
 * saved as e.g. Charizard-Mega-X shows its Mega art once it Mega Evolves.
 */
export function convertTeam(members: BattleTeamMember[], versionGroup: VersionGroup | null): TeamConversion {
	const rules = rulesFor(versionGroup);
	const problems: string[] = [];
	const team: PokemonSet[] = [];
	const visualMeta: VisualMetaMap = {};

	for (const member of members) {
		const set = convertMember(member, rules, problems);
		if (!set) continue;
		team.push(set);
		visualMeta[showdownIdFromSlug(member.slug)] = {
			pokemonId: member.pokemonId,
			shiny: member.shiny,
			female: member.gender === 'female',
		};
	}

	return problems.length ? { ok: false, problems } : { ok: true, rules, team, visualMeta };
}
