import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { PokemonSet } from '@pkmn/sim';
import { type RawData, WebSocketServer, type WebSocket } from 'ws';
import { isBattleFormatKey } from './formats.js';
import type { Choice, ClientMessage, ErrorCode, ServerMessage, SideID, VisualMetaMap } from './protocol.js';
import { Room, RoomRegistry } from './rooms.js';

const DEFAULT_PORT = Number(process.env.PORT ?? 3001);
const SWEEP_INTERVAL_MS = 60_000;

export interface BattleServerOptions {
	// WebSocket upgrades bypass CORS entirely, so this allowlist is the only origin check the battle server gets
	allowedOrigins?: string[];
}

export interface BattleServerHandle {
	server: Server;
	registry: RoomRegistry;
	close(): Promise<void>;
}

function send(ws: WebSocket, message: ServerMessage): void {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function sendError(ws: WebSocket, code: ErrorCode, message: string, problems?: string[]): void {
	send(ws, { t: 'error', code, message, problems });
}

function describeErrorCode(code: string): string {
	switch (code) {
		case 'room_not_found':
			return 'No battle room with that code.';
		case 'room_full':
			return 'That battle room already has two players.';
		case 'team_invalid':
			return 'Team failed validation for this format.';
		case 'invalid_seat_token':
			return 'That seat token is no longer valid - the room may have expired.';
		default:
			return 'Something went wrong.';
	}
}

function isPokemonSetArray(value: unknown): value is PokemonSet[] {
	return Array.isArray(value);
}

function isVisualMetaMap(value: unknown): value is VisualMetaMap {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChoice(value: unknown): value is Choice {
	if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
	const v = value as Record<string, unknown>;
	switch (v.kind) {
		case 'move':
			return typeof v.index === 'number';
		case 'switch':
			return typeof v.index === 'number';
		case 'team':
			return Array.isArray(v.order) && v.order.every(i => typeof i === 'number');
		case 'default':
		case 'undo':
			return true;
		default:
			return false;
	}
}

/** Wires up the HTTP health endpoint + WS room protocol, but does not call
 * `server.listen()` - callers decide the port (including 0, an ephemeral
 * port for tests) and lifecycle. */
export function createBattleServer(options: BattleServerOptions = {}): BattleServerHandle {
	const allowedOrigins = options.allowedOrigins ?? [];
	const registry = new RoomRegistry();

	const server = createServer((req, res) => {
		if (req.url === '/healthz') {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('ok');
			return;
		}
		res.writeHead(404);
		res.end();
	});

	const wss = new WebSocketServer({
		server,
		verifyClient(info, done) {
			if (allowedOrigins.length === 0) return done(true);
			done(allowedOrigins.includes(info.origin ?? ''));
		},
	});

	wss.on('connection', ws => {
		let room: Room | null = null;
		let seat: SideID | null = null;

		ws.on('message', (raw: RawData) => {
			let message: ClientMessage;
			try {
				message = JSON.parse(raw.toString());
			} catch {
				sendError(ws, 'invalid_message', 'Malformed JSON.');
				return;
			}

			switch (message.t) {
				case 'create': {
					if (room) return;
					if (
						!isBattleFormatKey(message.formatKey) ||
						typeof message.name !== 'string' ||
						!isPokemonSetArray(message.team) ||
						!isVisualMetaMap(message.visualMeta)
					) {
						sendError(ws, 'invalid_message', 'Invalid create payload.');
						return;
					}
					const result = registry.create(message.formatKey, message.name, message.team, message.visualMeta, m => send(ws, m));
					if ('code' in result) {
						sendError(ws, result.code, describeErrorCode(result.code), 'problems' in result ? result.problems : undefined);
						return;
					}
					room = result.room;
					seat = 'p1';
					send(ws, { t: 'created', code: room.code, seat, seatToken: result.seatInfo.seatToken, format: room.format });
					break;
				}
				case 'join': {
					if (room) return;
					if (
						typeof message.code !== 'string' ||
						typeof message.name !== 'string' ||
						!isPokemonSetArray(message.team) ||
						!isVisualMetaMap(message.visualMeta)
					) {
						sendError(ws, 'invalid_message', 'Invalid join payload.');
						return;
					}
					const result = registry.join(message.code, message.name, message.team, message.visualMeta, m => send(ws, m));
					if ('code' in result) {
						sendError(ws, result.code, describeErrorCode(result.code), 'problems' in result ? result.problems : undefined);
						return;
					}
					room = result.room;
					seat = 'p2';
					send(ws, { t: 'joined', code: room.code, seat, seatToken: result.seatInfo.seatToken, format: room.format });
					break;
				}
				case 'resume': {
					if (room) return;
					if (typeof message.code !== 'string' || typeof message.seatToken !== 'string') {
						sendError(ws, 'invalid_message', 'Invalid resume payload.');
						return;
					}
					const result = registry.resume(message.code, message.seatToken);
					if ('code' in result) {
						sendError(ws, result.code, describeErrorCode(result.code));
						return;
					}
					room = result.room;
					seat = result.side;
					room.attachTransport(seat, m => send(ws, m));
					room.handleReconnect(seat);
					room.broadcastRoomState();
					break;
				}
				case 'choose': {
					if (!room || !seat) {
						sendError(ws, 'not_your_turn', 'No active room.');
						return;
					}
					if (typeof message.rqid !== 'number' || !isChoice(message.choice)) {
						sendError(ws, 'invalid_message', 'Invalid choice payload.');
						return;
					}
					room.choose(seat, message.rqid, message.choice);
					break;
				}
				case 'leave': {
					if (room && seat) room.handleDisconnect(seat);
					room = null;
					seat = null;
					break;
				}
				case 'rematch': {
					if (!room) {
						sendError(ws, 'not_your_turn', 'No active room.');
						return;
					}
					const result = room.rematch();
					if (!result.ok) {
						sendError(ws, 'rematch_unavailable', result.reason);
						return;
					}
					room.broadcastRoomState();
					break;
				}
				default:
					// message.t is typed `never` here since the switch above is
					// exhaustive over ClientMessage, but a malformed/unexpected
					// payload from an untrusted socket can still land here at
					// runtime with an arbitrary "t".
					sendError(ws, 'invalid_message', `Unhandled message type "${(message as { t: unknown }).t}".`);
			}
		});

		ws.on('close', () => {
			if (room && seat) room.handleDisconnect(seat);
		});
	});

	const sweepTimer = setInterval(() => registry.sweep(), SWEEP_INTERVAL_MS);
	sweepTimer.unref();

	return {
		server,
		registry,
		close(): Promise<void> {
			clearInterval(sweepTimer);
			return new Promise(resolve => {
				wss.close(() => server.close(() => resolve()));
			});
		},
	};
}

// process.argv[1] can be relative (e.g. "src/index.ts" from `npm start`)
// while import.meta.url is always an absolute file:// URL - comparing them
// directly would silently never match, so pathToFileURL resolves argv[1]
// against cwd first.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const allowedOrigins = (process.env.BATTLE_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean);
	const handle = createBattleServer({ allowedOrigins });
	handle.server.listen(DEFAULT_PORT, () => {
		console.log(`pokepedia-battle listening on :${DEFAULT_PORT}`);
	});
}
