/**
 * Checks src/teamConvert.ts against hand-written PokePedia team members that
 * cover each conversion rule: Stat Exp/DVs (gens 1-2), Hidden Power typing,
 * version groups with no ability picker, battle-only formes saved directly
 * (Mega, Gmax, Crowned), and the slugs that need the Showdown id override.
 * Every converted team must pass the real TeamValidator for its format.
 *
 * Usage: npx tsx scripts/convert-check.ts [--verbose]
 */
import type { PokemonSet } from '@pkmn/sim';
import { formatFor } from '../src/formats.js';
import type { BattleTeamMember, StatSpread } from '../src/protocol.js';
import { convertTeam } from '../src/teamConvert.js';
import { validateTeam } from '../src/teams.js';
import type { VersionGroup } from '../src/versionRules.js';

const verbose = process.argv.includes('--verbose');

const spread = (n: number): StatSpread => ({ hp: n, atk: n, def: n, spa: n, spd: n, spe: n });

function member(overrides: Partial<BattleTeamMember> & Pick<BattleTeamMember, 'slug' | 'moves'>): BattleTeamMember {
	return {
		pokemonId: 0,
		nickname: null,
		shiny: false,
		gender: 'genderless',
		ability: null,
		level: 100,
		nature: 'hardy',
		item: null,
		evs: spread(84),
		ivs: spread(31),
		happiness: 255,
		teraType: null,
		dynamaxLevel: 10,
		gigantamax: false,
		...overrides,
	};
}

interface Case {
	label: string;
	versionGroup: VersionGroup | null;
	member: BattleTeamMember;
	expect: (set: PokemonSet) => string | null;
}

const CASES: Case[] = [
	{
		label: 'gen 1 Stat Exp/DVs are rescaled',
		versionGroup: 'RED_BLUE',
		member: member({ slug: 'tauros', moves: ['Body Slam', 'Hyper Beam', 'Earthquake', 'Blizzard'], evs: spread(65535), ivs: spread(15) }),
		expect: s => (s.evs.atk === 252 && s.ivs.atk === 30 ? null : `evs/ivs ${JSON.stringify(s.evs)} ${JSON.stringify(s.ivs)}`),
	},
	{
		label: 'gen 2 Hidden Power type comes from DVs',
		versionGroup: 'GOLD_SILVER',
		// Atk DV 13 / Def DV 13 is Hidden Power Bug.
		member: member({ slug: 'snorlax', moves: ['Body Slam', 'Rest', 'Curse', 'Hidden Power'], item: 'leftovers', ivs: { hp: 15, atk: 13, def: 13, spa: 15, spd: 15, spe: 15 } }),
		expect: s => (s.hpType === 'Bug' && s.item === 'Leftovers' ? null : `hpType ${s.hpType}, item ${s.item}`),
	},
	{
		label: 'no ability picker falls back to the first ability',
		versionGroup: 'LETS_GO_PIKACHU_LETS_GO_EEVEE',
		member: member({ slug: 'mewtwo', moves: ['Psychic', 'Ice Beam', 'Recover', 'Calm Mind'], nature: 'timid' }),
		expect: s => (s.ability === 'Pressure' && s.nature === 'Timid' ? null : `ability ${s.ability}, nature ${s.nature}`),
	},
	{
		label: 'Legends Z-A Mega forme becomes base + Mega Stone',
		versionGroup: 'LEGENDS_ZA',
		member: member({ slug: 'charizard-mega-x', moves: ['Flare Blitz', 'Dragon Claw', 'Earthquake', 'Swords Dance'] }),
		expect: s => (s.species === 'Charizard' && s.item === 'Charizardite X' && s.ability === 'Blaze' ? null : `${s.species} @ ${s.item} / ${s.ability}`),
	},
	{
		label: 'Gmax forme becomes base + gigantamax',
		versionGroup: 'SWORD_SHIELD',
		member: member({ slug: 'charizard-gmax', moves: ['Flamethrower', 'Air Slash', 'Solar Beam', 'Roost'] }),
		expect: s => (s.species === 'Charizard' && s.gigantamax === true ? null : `${s.species} gmax=${s.gigantamax}`),
	},
	{
		label: 'slug override + Tera type',
		versionGroup: 'SCARLET_VIOLET',
		member: member({ slug: 'meowstic-female', gender: 'female', moves: ['Psychic', 'Shadow Ball', 'Calm Mind', 'Tera Blast'], teraType: 'FAIRY', ability: 'Competitive' }),
		expect: s => (s.species === 'Meowstic-F' && s.teraType === 'Fairy' && s.gender === 'F' ? null : `${s.species} tera ${s.teraType} gender ${s.gender}`),
	},
	{
		label: 'Home team: Crowned forme becomes base + Rusted Sword',
		versionGroup: null,
		member: member({ slug: 'zacian-crowned', moves: ['Iron Head', 'Close Combat', 'Play Rough', 'Swords Dance'], nickname: 'Wolfy' }),
		expect: s => (s.species === 'Zacian' && s.item === 'Rusted Sword' && s.name === 'Wolfy' ? null : `${s.species} @ ${s.item} named ${s.name}`),
	},
	{
		label: 'Mega whose sim base is unobtainable falls back to the plain species',
		versionGroup: null,
		member: member({ slug: 'floette-mega', moves: ['Moonblast', 'Calm Mind', 'Synthesis', 'Psychic'], gender: 'female' }),
		expect: s => (s.species === 'Floette' && s.item === 'Floettite' ? null : `${s.species} @ ${s.item}`),
	},
];

let failures = 0;
for (const c of CASES) {
	const result = convertTeam([c.member], c.versionGroup);
	let failure: string | null;
	if (!result.ok) {
		failure = `conversion failed: ${result.problems.join('; ')}`;
	} else {
		const set = result.team[0];
		const validation = validateTeam(formatFor(result.rules.formatKey), result.team);
		failure = c.expect(set) ?? (validation.valid ? null : `validator: ${validation.problems.join('; ')}`);
		if (verbose) console.log(JSON.stringify(set));
	}
	console.log(`${failure ? 'FAIL' : 'ok  '} ${c.label}${failure ? ` - ${failure}` : ''}`);
	if (failure) failures++;
}

const unknown = convertTeam([member({ slug: 'not-a-pokemon', moves: ['Tackle'] })], null);
const unknownOk = !unknown.ok && unknown.problems.some(p => p.includes('not-a-pokemon'));
console.log(`${unknownOk ? 'ok  ' : 'FAIL'} unknown species is reported as a problem`);
if (!unknownOk) failures++;

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
