import type { PlayerStreams } from './engine.js';
import type { ServerMessage } from './protocol.js';

type StreamSide = PlayerStreams['p1'] | PlayerStreams['p2'];
type Transport = (message: ServerMessage) => void;

/**
 * One player's seat in a room. A seat exists from the moment a player
 * creates/joins - independent of whether the engine has started yet - and
 * is later bound to that seat's (already redacted, see engine.ts) player
 * stream once both players are present.
 *
 * The transport (currently a WebSocket send callback) is swappable via
 * attach()/detach(), which is what Phase 6 reconnect needs: a socket can
 * drop and reattach mid-battle without the underlying player stream ever
 * knowing. Everything pumped from the stream while nothing is attached is
 * buffered and replayed to whatever attaches next.
 */
export class Seat {
	private readonly buffer: string[] = [];
	private transport: Transport | null = null;
	private stream: StreamSide | null = null;

	bindStream(stream: StreamSide): void {
		this.stream = stream;
		void this.pump(stream);
	}

	private async pump(stream: StreamSide): Promise<void> {
		for await (const chunk of stream) {
			if (!chunk) continue;
			const lines = chunk.split('\n');
			this.buffer.push(...lines);
			this.send({ t: 'update', lines });
		}
	}

	attach(transport: Transport): void {
		this.transport = transport;
		if (this.buffer.length) transport({ t: 'update', lines: this.buffer.slice() });
	}

	detach(): void {
		this.transport = null;
	}

	send(message: ServerMessage): void {
		this.transport?.(message);
	}

	choose(choice: string): void {
		this.stream?.write(choice);
	}
}
