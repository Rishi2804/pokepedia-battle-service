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

export type EvModel = 'ev255' | 'ev252' | 'statExp' | 'av' | 'effortLevel';
export type IvModel = 'iv' | 'dv';

/**
 * What a game lets a team member have and how its numbers are scaled: the one
 * table of per-game rules. The team builder reads it (exported as JSON by
 * `npm run dumprules`, see scripts/dump-rules.ts) instead of keeping its own
 * copy, and this server derives ConversionRules from it. Some of it only
 * matters to the builder's screens (the EV label and caps, whether there is a
 * Poke Ball field), but those are facts about the same games.
 */
export interface GameRules {
	/** The battle format this game's teams play under. */
	formatKey: BattleFormatKey;
	abilities: boolean;
	items: boolean;
	natures: boolean;
	/** 'statExp' teams store raw Stat Exp (0-65535), 'av' Awakening Values,
	 * 'effortLevel' Legends: Arceus effort levels. */
	evModel: EvModel;
	evLabel: string;
	evCap: number;
	evTotalCap: number | null;
	/** 'dv' teams store DVs (0-15) instead of IVs. */
	ivModel: IvModel;
	hiddenPower: boolean;
	tera: boolean;
	dynamax: boolean;
	happiness: boolean;
	pokeball: boolean;
}

/** The parts of GameRules that change how a team member becomes a Showdown set. */
export interface ConversionRules {
	formatKey: BattleFormatKey;
	statExp: boolean;
	dvs: boolean;
	happiness: boolean;
	hiddenPower: boolean;
	tera: boolean;
	dynamax: boolean;
}

type Rules = Omit<GameRules, 'formatKey'>;

const GEN_1: Rules = {
	abilities: false, items: false, natures: false,
	evModel: 'statExp', evLabel: 'Stat Exp', evCap: 65535, evTotalCap: null,
	ivModel: 'dv', hiddenPower: false, tera: false, dynamax: false,
	happiness: false, pokeball: false,
};
const GEN_2: Rules = { ...GEN_1, items: true, hiddenPower: true, happiness: true };
const GEN_3_5: Rules = {
	abilities: true, items: true, natures: true,
	evModel: 'ev255', evLabel: 'EVs', evCap: 255, evTotalCap: 510,
	ivModel: 'iv', hiddenPower: true, tera: false, dynamax: false,
	happiness: true, pokeball: true,
};
const GEN_6_7: Rules = { ...GEN_3_5, evModel: 'ev252', evCap: 252 };
const LGPE: Rules = {
	abilities: false, items: false, natures: true,
	evModel: 'av', evLabel: 'AVs', evCap: 200, evTotalCap: null,
	ivModel: 'iv', hiddenPower: false, tera: false, dynamax: false,
	happiness: false, pokeball: false,
};
const SWSH: Rules = { ...GEN_6_7, hiddenPower: false, dynamax: true };
const BDSP: Rules = { ...GEN_6_7 };
const LA: Rules = {
	abilities: false, items: false, natures: false,
	evModel: 'effortLevel', evLabel: 'Effort Level', evCap: 10, evTotalCap: null,
	ivModel: 'iv', hiddenPower: false, tera: false, dynamax: false,
	happiness: false, pokeball: false,
};
const ZA: Rules = {
	abilities: false, items: true, natures: true,
	evModel: 'ev252', evLabel: 'EVs', evCap: 252, evTotalCap: 510,
	ivModel: 'iv', hiddenPower: false, tera: false, dynamax: false,
	happiness: false, pokeball: false,
};
const SV: Rules = { ...GEN_6_7, hiddenPower: false, tera: true };

// One entry per version group rather than per generation: several share a gen
// number (SWSH/BDSP/LA are all gen 8, SV/ZA both gen 9) with unrelated rules.
const RULES: Record<VersionGroup, GameRules> = {
	RED_BLUE: { ...GEN_1, formatKey: 1 },
	YELLOW: { ...GEN_1, formatKey: 1 },
	GOLD_SILVER: { ...GEN_2, formatKey: 2 },
	CRYSTAL: { ...GEN_2, formatKey: 2 },
	RUBY_SAPPHIRE: { ...GEN_3_5, formatKey: 3 },
	EMERALD: { ...GEN_3_5, formatKey: 3 },
	FIRERED_LEAFGREEN: { ...GEN_3_5, formatKey: 3 },
	DIAMOND_PEARL: { ...GEN_3_5, formatKey: 4 },
	PLATINUM: { ...GEN_3_5, formatKey: 4 },
	HEARTGOLD_SOULSILVER: { ...GEN_3_5, formatKey: 4 },
	BLACK_WHITE: { ...GEN_3_5, formatKey: 5 },
	BLACK_2_WHITE_2: { ...GEN_3_5, formatKey: 5 },
	X_Y: { ...GEN_6_7, formatKey: 6 },
	OMEGA_RUBY_ALPHA_SAPPHIRE: { ...GEN_6_7, formatKey: 6 },
	SUN_MOON: { ...GEN_6_7, formatKey: 7 },
	ULTRA_SUN_ULTRA_MOON: { ...GEN_6_7, formatKey: 7 },
	LETS_GO_PIKACHU_LETS_GO_EEVEE: { ...LGPE, formatKey: 7 },
	SWORD_SHIELD: { ...SWSH, formatKey: 8 },
	BRILLIANT_DIAMOND_AND_SHINING_PEARL: { ...BDSP, formatKey: 8 },
	LEGENDS_ARCEUS: { ...LA, formatKey: 8 },
	SCARLET_VIOLET: { ...SV, formatKey: 9 },
	LEGENDS_ZA: { ...ZA, formatKey: 'legendsza' },
};

/** A "Home"/national team isn't pinned to a game: National Dex AG under
 * Scarlet/Violet's rules, the most current and most permissive set. */
const HOME_RULES: GameRules = { ...SV, formatKey: 'nationaldex' };

export function gameRulesFor(versionGroup: VersionGroup | null): GameRules {
	return versionGroup ? RULES[versionGroup] : HOME_RULES;
}

/** Every version group's rules plus the Home team's, as the team builder reads them. */
export function allGameRules(): { versionGroups: Record<VersionGroup, GameRules>; home: GameRules } {
	return { versionGroups: RULES, home: HOME_RULES };
}

export function rulesFor(versionGroup: VersionGroup | null): ConversionRules {
	const game = gameRulesFor(versionGroup);
	return {
		formatKey: game.formatKey,
		statExp: game.evModel === 'statExp',
		dvs: game.ivModel === 'dv',
		happiness: game.happiness,
		hiddenPower: game.hiddenPower,
		tera: game.tera,
		dynamax: game.dynamax,
	};
}
