import { Sprites } from '@pkmn/img';
import type { BattleSprite, DynamaxState } from './protocol.js';

// Where the browser fetches Showdown sprites from - PokePedia's own image
// store, not play.pokemonshowdown.com, so it has to be an address the browser
// can reach. Unset means @pkmn/img's default (Showdown's own domain).
const DOMAIN = process.env.SHOWDOWN_SPRITES_DOMAIN || undefined;
const PROTOCOL = (process.env.SHOWDOWN_SPRITES_PROTOCOL as 'http' | 'https' | undefined) ?? (DOMAIN ? 'http' : 'https');

// Showdown (battle-dex.ts getSpriteData) doubles a Dynamaxed sprite but not a
// Gigantamaxed one, because its Gmax art is already drawn far larger. The UI
// contains every sprite in a fixed box (which cancels that larger canvas), so
// Gmax needs an enlargement of its own too.
const DYNAMAX_SCALE = 1.8;
const GIGANTAMAX_SCALE = 1.5;

/** `facing` is what the sprite shows, not which seat it is: 'p1' is the back
 * sprite (the viewer's own Pokemon), 'p2' the front (the opponent's). */
export function battleSprite(speciesForme: string, opts: {
	facing: 'p1' | 'p2';
	shiny: boolean;
	gender: 'M' | 'F' | 'N';
	gen: number;
	dynamax: DynamaxState | null;
}): BattleSprite {
	// While Gigantamaxed, Showdown swaps to the "<forme>-Gmax" sprite.
	const forme = opts.dynamax === 'gigantamax' && !speciesForme.endsWith('-Gmax') ? `${speciesForme}-Gmax` : speciesForme;
	const scale = opts.dynamax === 'gigantamax' ? GIGANTAMAX_SCALE : opts.dynamax === 'dynamax' ? DYNAMAX_SCALE : 1;
	const sprite = Sprites.getPokemon(forme, {
		side: opts.facing,
		shiny: opts.shiny,
		gender: opts.gender,
		gen: opts.gen,
		domain: DOMAIN,
		protocol: PROTOCOL,
	});
	return { url: sprite.url, w: sprite.w, h: sprite.h, pixelated: sprite.pixelated, scale };
}
