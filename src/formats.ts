/**
 * AG is native only for gens 4/6/7/8/9 (pokemon-showdown/config/formats.ts);
 * other gens synthesize it on that gen's Custom Game via `@@@` - "Standard AG"
 * (data/rulesets.ts) gives Obtainable/Team Preview/HP% Mod/Cancel Mod/Endless
 * Battle Clause, plus the same team/move/level caps as real AG.
 *
 * Repeal rules (`!Rule`) must omit "= value" - Showdown keys a repeal by rule
 * id only (sim/dex-formats.ts validateRule/getRuleTable), so
 * "!Max Team Size = 24" silently fails to repeal "Max Team Size = 24"
 * (verified against @pkmn/sim 0.10.11).
 */
const NATIVE_AG_GENS = new Set([4, 6, 7, 8, 9]);

const SYNTHESIZED_AG_SUFFIX =
	'@@@Standard AG,!Max Team Size,!Max Move Count,!Max Level,' +
	'Max Team Size = 6,Max Move Count = 4,Max Level = 100';

export type SupportedGen = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * What a room plays under. Usually just a generation, but the "Home"/national
 * team isn't pinned to one game, so it gets National Dex AG instead - every
 * Pokemon from every gen, with Mega Evolution, Z-Moves and Terastallization
 * all available at once.
 */
export type BattleFormatKey = SupportedGen | 'nationaldex';

/**
 * Legends: Z-A Mega Stones. `@pkmn/sim` tags these `isNonstandard: 'Future'`,
 * but National Dex AG only unbans `Past`, so each needs both gates:
 *   +Future      unbans the mega *forme* (e.g. Clefable-Mega)
 *   +item:<id>   satisfies NatDex Mod's onValidateSet (data/rulesets.ts),
 *                which walks an item back through gens 9->7 looking for a
 *                standard gen - a Future item can never satisfy that, so
 *                this uses the check's explicit `+item:` escape hatch.
 * If a future @pkmn/sim bump retags these `Past`, the `+item:` unbans become
 * harmless no-ops, so this list can just be deleted then.
 */
const ZA_MEGA_STONE_IDS = [
	'absolitez', 'barbaracite', 'baxcalibrite', 'chandelurite',
	'chesnaughtite', 'chimechite', 'clefablite', 'crabominite', 'darkranite',
	'delphoxite', 'dragalgite', 'dragoninite', 'drampanite', 'eelektrossite',
	'emboarite', 'excadrite', 'falinksite', 'feraligite', 'floettite',
	'froslassite', 'garchompitez', 'glimmoranite', 'golisopite', 'golurkite',
	'greninjite', 'hawluchanite', 'heatranite', 'lucarionitez', 'magearnite',
	'malamarite', 'meganiumite', 'meowsticite', 'pyroarite', 'raichunitex',
	'raichunitey', 'scolipite', 'scovillainite', 'scraftinite', 'skarmorite',
	'staraptite', 'starminite', 'tatsugirinite', 'victreebelite',
	'zeraorite', 'zygardite',
];

/**
 * `+LGPE` clears the Let's Go tag on Pikachu-Starter/Eevee-Starter and their
 * exclusive moves (Zippy Zap, Splishy Splash, Floaty Fall). The `+pokemon:`
 * unbans clear a *separate* NatDex Mod check rejecting
 * `natDexTier === 'Illegal'` species, via the same kind of `+pokemon:<id>`
 * hatch as `+item:` above. The rest of that Illegal tier is Gmax formes,
 * Pokestar props and CAP fakemon - not real species.
 */
const NATIONAL_DEX_FORMAT = [
	'gen9nationaldexag@@@+Future',
	'+LGPE',
	'+pokemon:pikachustarter',
	'+pokemon:eeveestarter',
	...ZA_MEGA_STONE_IDS.map(id => `+item:${id}`),
].join(',');

export function isSupportedGen(gen: number): gen is SupportedGen {
	return Number.isInteger(gen) && gen >= 1 && gen <= 9;
}

export function isBattleFormatKey(key: unknown): key is BattleFormatKey {
	return key === 'nationaldex' || (typeof key === 'number' && isSupportedGen(key));
}

export function formatFor(key: BattleFormatKey): string {
	if (key === 'nationaldex') return NATIONAL_DEX_FORMAT;
	if (NATIVE_AG_GENS.has(key)) return `gen${key}anythinggoes`;
	return `gen${key}customgame${SYNTHESIZED_AG_SUFFIX}`;
}
