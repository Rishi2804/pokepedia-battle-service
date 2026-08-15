/**
 * Anything Goes is only defined natively for gens 4, 6, 7, 8, 9
 * (pokemon-showdown/config/formats.ts). For the remaining gens we synthesize
 * it on top of that gen's Custom Game using the `@@@` custom-rules syntax:
 * "Standard AG" (data/rulesets.ts) gives Obtainable / Team Preview / HP
 * Percentage Mod / Cancel Mod / Endless Battle Clause, and we cap team/move
 * count and level the same way real AG does.
 *
 * Repeal rules (`!Rule`) must omit the "= value" part - Showdown keys a
 * repeal by rule id only (sim/dex-formats.ts validateRule/getRuleTable), so
 * "!Max Team Size = 24" and "Max Team Size = 24" register under different
 * keys and the repeal silently fails to match. Verified against
 * @pkmn/sim 0.10.11 during implementation.
 */
const NATIVE_AG_GENS = new Set([4, 6, 7, 8, 9]);

const SYNTHESIZED_AG_SUFFIX =
	'@@@Standard AG,!Max Team Size,!Max Move Count,!Max Level,' +
	'Max Team Size = 6,Max Move Count = 4,Max Level = 100';

export type SupportedGen = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export function isSupportedGen(gen: number): gen is SupportedGen {
	return Number.isInteger(gen) && gen >= 1 && gen <= 9;
}

export function formatFor(gen: SupportedGen): string {
	if (NATIVE_AG_GENS.has(gen)) return `gen${gen}anythinggoes`;
	return `gen${gen}customgame${SYNTHESIZED_AG_SUFFIX}`;
}
