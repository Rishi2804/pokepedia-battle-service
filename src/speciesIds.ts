/** Showdown's own toID (sim/dex-data.ts): lowercase, strip everything that
 * isn't a-z0-9. */
export function toShowdownId(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * PokePedia stores PokeAPI-style slugs (e.g. "raichu-alola"). Normalizing one
 * with toShowdownId lands on Showdown's species id for all but these 46,
 * where PokeAPI names a forme differently ("meowstic-female" is Showdown's
 * "Meowstic-F", "necrozma-dusk" is "Necrozma-Dusk-Mane"). Copied from
 * pokepedia-ui/src/global/data/showdownSpecies.ts, which still needs its own
 * copy for the team builder's Showdown paste import/export.
 */
const SLUG_TO_SHOWDOWN_ID: Record<string, string> = {
	'deoxys-normal': 'deoxys',
	'wormadam-plant': 'wormadam',
	'giratina-altered': 'giratina',
	'shaymin-land': 'shaymin',
	'basculin-red-striped': 'basculin',
	'darmanitan-standard': 'darmanitan',
	'darmanitan-galar-standard': 'darmanitangalar',
	'tornadus-incarnate': 'tornadus',
	'thundurus-incarnate': 'thundurus',
	'landorus-incarnate': 'landorus',
	'keldeo-ordinary': 'keldeo',
	'meloetta-aria': 'meloetta',
	'meowstic-male': 'meowstic',
	'meowstic-female': 'meowsticf',
	'aegislash-shield': 'aegislash',
	'pumpkaboo-average': 'pumpkaboo',
	'gourgeist-average': 'gourgeist',
	'zygarde-50': 'zygarde',
	'oricorio-baile': 'oricorio',
	'lycanroc-midday': 'lycanroc',
	'wishiwashi-solo': 'wishiwashi',
	'mimikyu-disguised': 'mimikyu',
	'toxtricity-amped': 'toxtricity',
	'eiscue-ice': 'eiscue',
	'indeedee-male': 'indeedee',
	'indeedee-female': 'indeedeef',
	'morpeko-full-belly': 'morpeko',
	'urshifu-single-strike': 'urshifu',
	'urshifu-single-strike-gmax': 'urshifugmax',
	'basculegion-male': 'basculegion',
	'basculegion-female': 'basculegionf',
	'enamorus-incarnate': 'enamorus',
	'minior-red': 'minior',
	'necrozma-dusk': 'necrozmaduskmane',
	'necrozma-dawn': 'necrozmadawnwings',
	'oinkologne-female': 'oinkolognef',
	'maushold-family-of-three': 'mausholdfour',
	'tauros-paldea-combat-breed': 'taurospaldeacombat',
	'tauros-paldea-blaze-breed': 'taurospaldeablaze',
	'tauros-paldea-aqua-breed': 'taurospaldeaaqua',
	'squawkabilly-blue-plumage': 'squawkabillyblue',
	'squawkabilly-yellow-plumage': 'squawkabillyyellow',
	'squawkabilly-white-plumage': 'squawkabillywhite',
	'ogerpon-wellspring-mask': 'ogerponwellspring',
	'ogerpon-hearthflame-mask': 'ogerponhearthflame',
	'ogerpon-cornerstone-mask': 'ogerponcornerstone',
};

export function showdownIdFromSlug(slug: string): string {
	return SLUG_TO_SHOWDOWN_ID[slug] ?? toShowdownId(slug);
}
