import type { BattleFormatKey } from './formats.js';

/**
 * PokePedia's version groups, as the UI's VersionGroup enum spells them
 * (pokepedia-ui/src/global/enums.ts). A team carries one of these, or null
 * for a "Home"/national team that isn't pinned to a game.
 */
export const VERSION_GROUPS = [
	'RED_BLUE', 'YELLOW', 'GOLD_SILVER', 'CRYSTAL',
	'RUBY_SAPPHIRE', 'EMERALD', 'FIRERED_LEAFGREEN',
	'DIAMOND_PEARL', 'PLATINUM', 'HEARTGOLD_SOULSILVER',
	'BLACK_WHITE', 'BLACK_2_WHITE_2',
	'X_Y', 'OMEGA_RUBY_ALPHA_SAPPHIRE',
	'SUN_MOON', 'ULTRA_SUN_ULTRA_MOON', 'LETS_GO_PIKACHU_LETS_GO_EEVEE',
	'SWORD_SHIELD', 'BRILLIANT_DIAMOND_AND_SHINING_PEARL', 'LEGENDS_ARCEUS',
	'SCARLET_VIOLET', 'LEGENDS_ZA',
] as const;

export type VersionGroup = (typeof VERSION_GROUPS)[number];

export function isVersionGroup(value: unknown): value is VersionGroup {
	return typeof value === 'string' && (VERSION_GROUPS as readonly string[]).includes(value);
}

/**
 * Only the parts of the UI's GenRules (pokepedia-ui/src/pages/TeamBuilder/genRules.ts)
 * that change how a team member becomes a Showdown set. If a version group's
 * rules change there, change them here too.
 */
export interface ConversionRules {
	formatKey: BattleFormatKey;
	/** 'statExp' teams store raw Stat Exp (0-65535) instead of EVs. */
	statExp: boolean;
	/** 'dv' teams store DVs (0-15) instead of IVs. */
	dvs: boolean;
	happiness: boolean;
	hiddenPower: boolean;
	tera: boolean;
	dynamax: boolean;
}

const GEN_1: Omit<ConversionRules, 'formatKey'> = {
	statExp: true, dvs: true, happiness: false, hiddenPower: false, tera: false, dynamax: false,
};
const GEN_2 = { ...GEN_1, happiness: true, hiddenPower: true };
const GEN_3_7 = { statExp: false, dvs: false, happiness: true, hiddenPower: true, tera: false, dynamax: false };
const NO_EXTRAS = { statExp: false, dvs: false, happiness: false, hiddenPower: false, tera: false, dynamax: false };
const SWSH = { ...GEN_3_7, hiddenPower: false, dynamax: true };
const SV = { ...GEN_3_7, hiddenPower: false, tera: true };

const RULES: Record<VersionGroup, ConversionRules> = {
	RED_BLUE: { ...GEN_1, formatKey: 1 },
	YELLOW: { ...GEN_1, formatKey: 1 },
	GOLD_SILVER: { ...GEN_2, formatKey: 2 },
	CRYSTAL: { ...GEN_2, formatKey: 2 },
	RUBY_SAPPHIRE: { ...GEN_3_7, formatKey: 3 },
	EMERALD: { ...GEN_3_7, formatKey: 3 },
	FIRERED_LEAFGREEN: { ...GEN_3_7, formatKey: 3 },
	DIAMOND_PEARL: { ...GEN_3_7, formatKey: 4 },
	PLATINUM: { ...GEN_3_7, formatKey: 4 },
	HEARTGOLD_SOULSILVER: { ...GEN_3_7, formatKey: 4 },
	BLACK_WHITE: { ...GEN_3_7, formatKey: 5 },
	BLACK_2_WHITE_2: { ...GEN_3_7, formatKey: 5 },
	X_Y: { ...GEN_3_7, formatKey: 6 },
	OMEGA_RUBY_ALPHA_SAPPHIRE: { ...GEN_3_7, formatKey: 6 },
	SUN_MOON: { ...GEN_3_7, formatKey: 7 },
	ULTRA_SUN_ULTRA_MOON: { ...GEN_3_7, formatKey: 7 },
	LETS_GO_PIKACHU_LETS_GO_EEVEE: { ...NO_EXTRAS, formatKey: 7 },
	SWORD_SHIELD: { ...SWSH, formatKey: 8 },
	BRILLIANT_DIAMOND_AND_SHINING_PEARL: { ...GEN_3_7, formatKey: 8 },
	LEGENDS_ARCEUS: { ...NO_EXTRAS, formatKey: 8 },
	SCARLET_VIOLET: { ...SV, formatKey: 9 },
	LEGENDS_ZA: { ...NO_EXTRAS, formatKey: 'legendsza' },
};

/** A null version group is a "Home"/national team: National Dex AG under
 * Scarlet/Violet's rules, the same default the UI's getGenRules uses. */
export function rulesFor(versionGroup: VersionGroup | null): ConversionRules {
	return versionGroup ? RULES[versionGroup] : { ...SV, formatKey: 'nationaldex' };
}
