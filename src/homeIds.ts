/**
 * Showdown species id -> PokePedia pokemon id, for every forme PokePedia has
 * (each forme is its own `pokemon` row with its own HOME render). A team's own
 * roster only has art for the formes it was built with, so a Mega Evolution or
 * other mid-battle forme change needs this to find the right image.
 */
let homeIds: ReadonlyMap<string, number> = new Map();

export function homeSpriteId(speciesId: string): number | undefined {
	return homeIds.get(speciesId);
}

interface CandidateGroup {
	pokemon: { id: number; showdownId: string }[];
}

export function setHomeIds(groups: CandidateGroup[]): number {
	const map = new Map<string, number>();
	for (const group of groups) {
		for (const candidate of group.pokemon) {
			map.set(candidate.showdownId, candidate.id);
		}
	}
	homeIds = map;
	return map.size;
}

/** Fetches the national candidate list from the PokePedia API once. The API
 * may still be starting when this server boots, so a failure is retried a few
 * times; if it never succeeds sprites just fall back to national dex numbers. */
export async function loadHomeIds(
	apiUrl: string,
	options: { attempts?: number; delayMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<number> {
	const { attempts = 10, delayMs = 5000, fetchImpl = fetch } = options;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/team-building/national`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return setHomeIds((await response.json()) as CandidateGroup[]);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (attempt === attempts) {
				console.warn(`Could not load HOME sprite ids from ${apiUrl} (${reason}); falling back to dex numbers.`);
				return 0;
			}
			await new Promise(resolve => setTimeout(resolve, delayMs));
		}
	}
	return 0;
}
