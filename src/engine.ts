import { BattleStreams, type PokemonSet } from '@pkmn/sim';
import { packTeam } from './teams.js';

export type PlayerStreams = ReturnType<typeof BattleStreams.getPlayerStreams>;

export interface PlayerSpec {
	name: string;
	team: PokemonSet[];
}

/**
 * Wraps a single battle's BattleStream + getPlayerStreams() demux.
 *
 * getPlayerStreams() is what makes redaction structural rather than manual:
 * it resolves each `|split|` SECRET/PUBLIC pair into the one line the given
 * seat may see, and routes `sideupdate` chunks (which carry `|request|`)
 * only to that seat's stream (@pkmn/sim build/esm/sim/battle-stream.mjs).
 * Nothing downstream of `streams.p1` / `streams.p2` needs to know the
 * protocol has secrets in it at all.
 */
export class BattleEngine {
	readonly streams: PlayerStreams;
	private readonly battleStream: InstanceType<typeof BattleStreams.BattleStream>;

	constructor() {
		// keepAlive: true so the stream survives |win| for a rematch instead
		// of closing the moment the battle ends.
		this.battleStream = new BattleStreams.BattleStream({ keepAlive: true });
		this.streams = BattleStreams.getPlayerStreams(this.battleStream);
	}

	start(formatId: string, p1: PlayerSpec, p2: PlayerSpec): void {
		const lines = [
			`>start ${JSON.stringify({ formatid: formatId })}`,
			`>player p1 ${JSON.stringify({ name: p1.name, team: packTeam(p1.team) })}`,
			`>player p2 ${JSON.stringify({ name: p2.name, team: packTeam(p2.team) })}`,
		];
		void this.streams.omniscient.write(lines.join('\n'));
	}

	choose(seat: 'p1' | 'p2', choice: string): void {
		void this.streams[seat].write(choice);
	}

	destroy(): void {
		void this.streams.omniscient.writeEnd();
	}
}
