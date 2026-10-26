import { createServer, type IncomingMessage, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { PokemonSet } from '@pkmn/sim';
import { type RawData, WebSocketServer, type WebSocket } from 'ws';
import { type BattleFormatKey, formatFor } from './formats.js';
import type { BattleTeamMember, Choice, ClientMessage, ErrorCode, ServerMessage, SideID, StatSpread, VisualMetaMap } from './protocol.js';
import { loadHomeIds } from './homeIds.js';
import { Room, RoomRegistry } from './rooms.js';
import { convertTeam } from './teamConvert.js';
import { validateTeam } from './teams.js';
import { isVersionGroup, type VersionGroup } from './versionRules.js';

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
		case 'gen_mismatch':
			return "This room was created with a team from a different game - pick a team from the room's game to join.";
		case 'team_invalid':
			return 'Team failed validation for this format.';
		case 'invalid_seat_token':
			return 'That seat token is no longer valid - the room may have expired.';
		default:
			return 'Something went wrong.';
	}
}

const MAX_TEAM_MEMBERS = 24;
const GENDERS = ['male', 'female', 'genderless'];

function isStatSpread(value: unknown): value is StatSpread {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].every(stat => typeof v[stat] === 'number');
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

function isBattleTeamMember(value: unknown): value is BattleTeamMember {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.pokemonId === 'number' &&
		typeof v.slug === 'string' &&
		typeof v.showdownId === 'string' &&
		isNullableString(v.nickname) &&
		typeof v.shiny === 'boolean' &&
		typeof v.gender === 'string' && GENDERS.includes(v.gender) &&
		isNullableString(v.ability) &&
		Array.isArray(v.moves) && v.moves.every(m => typeof m === 'string') &&
		typeof v.level === 'number' &&
		typeof v.nature === 'string' &&
		isNullableString(v.item) &&
		isStatSpread(v.evs) &&
		isStatSpread(v.ivs) &&
		typeof v.happiness === 'number' &&
		isNullableString(v.teraType) &&
		typeof v.dynamaxLevel === 'number' &&
		typeof v.gigantamax === 'boolean'
	);
}

function isBattleTeam(value: unknown): value is BattleTeamMember[] {
	return Array.isArray(value) && value.length <= MAX_TEAM_MEMBERS && value.every(isBattleTeamMember);
}

type ResolvedTeam =
	| { ok: true; formatKey: BattleFormatKey; versionGroup: VersionGroup | null; team: PokemonSet[]; visualMeta: VisualMetaMap }
	| { ok: false; code: ErrorCode; message: string; problems?: string[] };

/** Validates a create/join payload and converts its PokePedia team into
 * Showdown sets + sprite metadata. The format comes from the team's version
 * group (src/versionRules.ts), never from the client. */
function resolveTeam(message: Extract<ClientMessage, { t: 'create' | 'join' }>): ResolvedTeam {
	if ((message.versionGroup !== null && !isVersionGroup(message.versionGroup)) || !isBattleTeam(message.team)) {
		return { ok: false, code: 'invalid_message', message: `Invalid ${message.t} payload.` };
	}
	try {
		const converted = convertTeam(message.team, message.versionGroup);
		if (!converted.ok) return { ok: false, code: 'team_invalid', message: describeErrorCode('team_invalid'), problems: converted.problems };
		return { ok: true, formatKey: converted.rules.formatKey, versionGroup: message.versionGroup, team: converted.team, visualMeta: converted.visualMeta };
	} catch (err) {
		return { ok: false, code: 'team_invalid', message: describeErrorCode('team_invalid'), problems: [err instanceof Error ? err.message : String(err)] };
	}
}

/** The result of POST /validate: the same problems creating or joining a room
 * with this team would report, without needing a room. */
export interface ValidateResponse {
	valid: boolean;
	problems: string[];
}

/** Checks a team the way a room would - conversion problems first (unknown
 * species, moves, abilities, items...), then Showdown's own validator for the
 * team's format - so the team builder can show them while a team is being
 * built instead of at battle time. */
function validateRequest(body: unknown): { ok: true; response: ValidateResponse } | { ok: false } {
	if (typeof body !== 'object' || body === null) return { ok: false };
	const { versionGroup, team } = body as { versionGroup?: unknown; team?: unknown };
	if (versionGroup === undefined || (versionGroup !== null && !isVersionGroup(versionGroup)) || !isBattleTeam(team)) {
		return { ok: false };
	}
	const resolved = resolveTeam({ t: 'create', versionGroup, name: '', team });
	if (!resolved.ok) return { ok: true, response: { valid: false, problems: resolved.problems ?? [resolved.message] } };
	const validation = validateTeam(formatFor(resolved.formatKey), resolved.team);
	return { ok: true, response: validation };
}

const MAX_VALIDATE_BODY_BYTES = 256 * 1024;

/** Reads a request body up to a size cap; null if it is over the cap. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
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

	// Browsers enforce CORS on plain HTTP requests, unlike the WS upgrade.
	const corsHeaders = (req: IncomingMessage): Record<string, string> => {
		const origin = req.headers.origin;
		const headers: Record<string, string> = {};
		if (allowedOrigins.length === 0) headers['access-control-allow-origin'] = '*';
		else if (origin && allowedOrigins.includes(origin)) headers['access-control-allow-origin'] = origin;
		return headers;
	};

	const server = createServer((req, res) => {
		if (req.url === '/healthz') {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('ok');
			return;
		}
		if (req.url === '/validate') {
			const headers = { ...corsHeaders(req), 'content-type': 'application/json' };
			if (req.method === 'OPTIONS') {
				// The preflight a browser sends before a cross-origin JSON POST.
				res.writeHead(204, { ...headers, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
				res.end();
				return;
			}
			if (req.method !== 'POST') {
				res.writeHead(405, { ...headers, allow: 'POST, OPTIONS' });
				res.end(JSON.stringify({ error: 'method_not_allowed' }));
				return;
			}
			readBody(req, MAX_VALIDATE_BODY_BYTES).then(raw => {
				if (raw === null) {
					res.writeHead(413, headers);
					res.end(JSON.stringify({ error: 'payload_too_large' }));
					return;
				}
				let body: unknown;
				try {
					body = JSON.parse(raw);
				} catch {
					res.writeHead(400, headers);
					res.end(JSON.stringify({ error: 'invalid_message' }));
					return;
				}
				const result = validateRequest(body);
				if (!result.ok) {
					res.writeHead(400, headers);
					res.end(JSON.stringify({ error: 'invalid_message' }));
					return;
				}
				res.writeHead(200, headers);
				res.end(JSON.stringify(result.response));
			}).catch(() => {
				res.writeHead(500, headers);
				res.end(JSON.stringify({ error: 'internal_error' }));
			});
			return;
		}
		const roomCode = /^\/rooms\/([A-Za-z0-9]{1,16})$/.exec(req.url ?? '')?.[1];
		if (roomCode) {
			// Lets the join screen show a room's format and lock the team picker to
			// its version group before the player commits to a WebSocket join.
			const headers: Record<string, string> = { ...corsHeaders(req), 'content-type': 'application/json' };
			const room = registry.get(roomCode);
			if (!room) {
				res.writeHead(404, headers);
				res.end(JSON.stringify({ error: 'room_not_found' }));
				return;
			}
			res.writeHead(200, headers);
			res.end(JSON.stringify({
				code: room.code,
				versionGroup: room.versionGroup,
				formatName: room.formatName,
				host: room.players.p1?.name ?? '',
				joinable: !room.isFull(),
			}));
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
					if (typeof message.name !== 'string') {
						sendError(ws, 'invalid_message', 'Invalid create payload.');
						return;
					}
					const resolved = resolveTeam(message);
					if (!resolved.ok) {
						sendError(ws, resolved.code, resolved.message, resolved.problems);
						return;
					}
					const result = registry.create(resolved.formatKey, resolved.versionGroup, message.name, resolved.team, resolved.visualMeta, m => send(ws, m));
					if ('code' in result) {
						sendError(ws, result.code, describeErrorCode(result.code), 'problems' in result ? result.problems : undefined);
						return;
					}
					room = result.room;
					seat = 'p1';
					send(ws, { t: 'created', code: room.code, seat, seatToken: result.seatInfo.seatToken, format: room.format, formatName: room.formatName });
					break;
				}
				case 'join': {
					if (room) return;
					if (typeof message.code !== 'string' || typeof message.name !== 'string') {
						sendError(ws, 'invalid_message', 'Invalid join payload.');
						return;
					}
					const resolved = resolveTeam(message);
					if (!resolved.ok) {
						sendError(ws, resolved.code, resolved.message, resolved.problems);
						return;
					}
					const result = registry.join(message.code, resolved.versionGroup, message.name, resolved.team, resolved.visualMeta, m => send(ws, m));
					if ('code' in result) {
						sendError(ws, result.code, describeErrorCode(result.code), 'problems' in result ? result.problems : undefined);
						return;
					}
					room = result.room;
					seat = 'p2';
					send(ws, { t: 'joined', code: room.code, seat, seatToken: result.seatInfo.seatToken, format: room.format, formatName: room.formatName });
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
	const apiUrl = process.env.POKEPEDIA_API_URL;
	if (apiUrl) {
		void loadHomeIds(apiUrl).then(count => {
			if (count > 0) console.log(`Loaded ${count} HOME sprite ids from ${apiUrl}`);
		});
	} else {
		console.warn('POKEPEDIA_API_URL is not set; forme sprites fall back to dex numbers.');
	}
}
