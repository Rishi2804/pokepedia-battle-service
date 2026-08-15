import { Dex, Teams, TeamValidator, type PokemonSet } from '@pkmn/sim';

export interface TeamValidationResult {
	valid: boolean;
	problems: string[];
}

export function validateTeam(formatId: string, team: PokemonSet[]): TeamValidationResult {
	try {
		const format = Dex.formats.get(formatId, true);
		const validator = new TeamValidator(format);
		const problems = validator.validateTeam(team);
		return problems === null ? { valid: true, problems: [] } : { valid: false, problems };
	} catch (err) {
		// A malformed set (missing fields, wrong types) can make the validator throw errors
		// Turn that into an ordinary validation failure instead of crashing the room
		return { valid: false, problems: [err instanceof Error ? err.message : String(err)] };
	}
}

// Packs a team for the `>player` sim-protocol line
export function packTeam(team: PokemonSet[]): string {
	return Teams.pack(team);
}
