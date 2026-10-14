/**
 * Checks the battle sprite URLs the server builds (src/sprites.ts) for the
 * cases the UI used to compute itself: generation art folders, shiny/back
 * variants, and the Dynamax/Gigantamax forme swap and scaling.
 *
 * Usage: npm run spritecheck
 */
process.env.SHOWDOWN_SPRITES_DOMAIN = 'localhost:9000/pokemon-images/showdown';

const { battleSprite } = await import('../src/sprites.js');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` - ${detail}`}`);
	if (!ok) failures++;
}

const base = { facing: 'p2' as const, shiny: false, gender: 'M' as const, gen: 9, dynamax: null };

const modern = battleSprite('Tauros', base);
check('modern gens use the hosted animated sprite', modern.url === 'http://localhost:9000/pokemon-images/showdown/sprites/ani/tauros.gif' && !modern.pixelated, modern.url);
check('back sprite for the viewer\'s own side', battleSprite('Tauros', { ...base, facing: 'p1' }).url.includes('/ani-back/'));
check('shiny sprite', battleSprite('Tauros', { ...base, shiny: true }).url.includes('/ani-shiny/'));
const gen1 = battleSprite('Tauros', { ...base, gen: 1 });
check('gen 1 uses the pixel-art folder', gen1.url.endsWith('/sprites/gen1/tauros.png') && gen1.pixelated, gen1.url);
check('gen 2 back shiny folder', battleSprite('Tauros', { ...base, gen: 2, facing: 'p1', shiny: true }).url.endsWith('/sprites/gen2-back-shiny/tauros.png'));
check('no scaling normally', modern.scale === 1);
const max = battleSprite('Corviknight', { ...base, dynamax: 'dynamax' });
check('Dynamax doubles the size and keeps the forme', max.scale === 1.8 && max.url.includes('corviknight.'), max.url);
const gmax = battleSprite('Charizard', { ...base, dynamax: 'gigantamax' });
check('Gigantamax swaps to the Gmax sprite', gmax.scale === 1.5 && gmax.url.includes('charizard-gmax'), gmax.url);
check('an already-Gmax forme is not suffixed twice', !battleSprite('Charizard-Gmax', { ...base, dynamax: 'gigantamax' }).url.includes('gmax-gmax'));

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
