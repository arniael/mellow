// Test de bout en bout : des navigateurs simulés s'appairent en WebRTC (sans serveur de signalisation),
// en passant par les LIENS contenus dans les QR codes, comme avec l'appareil photo d'un téléphone.
// Usage : node tests/e2e-sync.mjs        (SHOTS=/dossier pour enregistrer des captures d'écran)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SHOTS = process.env.SHOTS || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = 'http://127.0.0.1:' + server.address().port + '/';

const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const errors = [];

async function newDevice(name, cfg) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, locale: 'fr-FR' });
    await ctx.addInitScript((c) => {
        localStorage.setItem('safeModeTutorialSeen', 'true');
        localStorage.setItem('safeModeConfig', JSON.stringify(c));
    }, cfg);
    return ctx;
}
function watch(page, name) {
    page.on('pageerror', (e) => errors.push(name + ' pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); });
}
async function openApp(name, cfg) {
    const ctx = await newDevice(name, cfg);
    const page = await ctx.newPage();
    watch(page, name);
    await page.goto(URL_);
    await page.waitForSelector('#info-dlg[open]');
    await page.click('[data-action=closeInfo]');
    return { ctx, page };
}
async function openInvite(name, cfg, link) {   // comme un QR scanné avec l'appareil photo : on ouvre directement le lien
    const ctx = await newDevice(name, cfg);
    const page = await ctx.newPage();
    watch(page, name);
    await page.goto(link);
    return { ctx, page };
}
const shot = async (page, n) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, n + '.png') }); };
const chat = (page) => page.evaluate(() => document.getElementById('chat').innerText);
const state = (page) => page.getAttribute('#status-pill', 'data-state');
const pillHas = (page, txt) => page.waitForFunction((t) => document.getElementById('status-text').textContent.includes(t), txt, { timeout: 20000 });
const step = (s) => console.log('✓', s);

const A = await openApp('A', { name: 'Alice' });
const B = await openApp('B', { name: 'Bob', theme: 'light' });

// ---- mode local
assert.match(await chat(A.page), /Je traverse actuellement/);
assert.equal(await state(A.page), 'local');
await A.page.click('.chip >> nth=0');
await A.page.click('#switch-btn');
assert.equal(await A.page.getAttribute('body', 'data-turn'), 'partner');
assert.equal(await A.page.locator('#btn-config').evaluate((e) => getComputedStyle(e).pointerEvents), 'none');
await A.page.click('#switch-btn');
step('mode local : accueil, phrase rapide, tour de parole verrouillé');

// ---- A crée la conversation : le QR code contient un lien vers l'app
await A.page.click('#status-pill');
await A.page.click('[data-action=linkHost]');
await A.page.waitForFunction(() => document.getElementById('host-code').value.includes('#SM1o'));
const offerLink = await A.page.inputValue('#host-code');
assert.ok(offerLink.startsWith(URL_ + '#SM1o'), 'le lien pointe vers l\'app : ' + offerLink.slice(0, 60));
await shot(A.page, '01-host-qr');
console.log('  lien d\'invitation :', offerLink.length, 'caractères');

// ---- B : mauvais code d'abord, puis le lien collé
await B.page.click('#status-pill');
await B.page.click('[data-action=linkGuest]');
await B.page.fill('#guest-offer', 'nimportequoi');
await B.page.click('[data-action=guestContinue]');
await B.page.waitForSelector('#guest-error:not([hidden])');
assert.equal(await state(B.page), 'local', 'un mauvais code ne doit pas lancer de session');
await B.page.fill('#guest-offer', 'Rejoins-moi : ' + offerLink + ' merci'); // texte autour du lien toléré
await B.page.click('[data-action=guestContinue]');
await B.page.waitForFunction(() => document.getElementById('guest-code').value.includes('#SM1a'));
const answerLink = await B.page.inputValue('#guest-code');
await shot(B.page, '02-guest-qr');

// le lien « offre » collé côté hôte est refusé (mauvais type de code)
await A.page.fill('#host-answer', offerLink);
await A.page.click('[data-action=hostConnect]');
await A.page.waitForSelector('#host-error:not([hidden])');
step('codes invalides refusés avec un message clair');

// ---- A scanne la réponse avec l'APPAREIL PHOTO : le lien s'ouvre dans un nouvel onglet qui transmet à l'onglet en attente
const C = await A.ctx.newPage();
watch(C, 'A-onglet-reponse');
await C.goto(answerLink);
await pillHas(A.page, '2');
await B.page.waitForFunction(() => document.getElementById('status-pill').dataset.state === 'live', null, { timeout: 20000 });
step('connexion WebRTC établie via le lien de réponse (« ' + (await A.page.innerText('#status-text')) + ' »)');
assert.equal(await A.page.evaluate(() => document.getElementById('toast').matches(':popover-open')), true, 'les notifications s\'affichent au-dessus des fenêtres');
await shot(A.page, '03-host-live');

// sans conversation en attente dans le navigateur : message explicite, rien ne se connecte
const E = await openInvite('E', {}, answerLink);
await E.page.waitForFunction(() => /Aucune conversation en attente/.test(document.getElementById('toast-text').textContent), null, { timeout: 5000 });
await E.ctx.close();
step('lien de réponse sans conversation en attente : message explicite');

// ---- troisième appareil : le lien s'ouvre directement et lance la jonction tout seul
await A.page.click('[data-action=linkAdd]');
await A.page.waitForFunction((prev) => document.getElementById('host-code').value.includes('#SM1o') && document.getElementById('host-code').value !== prev, offerLink);
const offerLink2 = await A.page.inputValue('#host-code');
const D = await openInvite('D', { name: 'Dan' }, offerLink2);
await D.page.waitForFunction(() => document.getElementById('guest-code').value.includes('#SM1a'), null, { timeout: 20000 });
assert.equal(new URL(D.page.url()).hash, '', 'le code est retiré de la barre d\'adresse');
const answerLink2 = await D.page.inputValue('#guest-code');
await shot(D.page, '04-invite-opened');
const C2 = await A.ctx.newPage();
watch(C2, 'A-onglet-reponse-2');
await C2.goto(answerLink2);
await pillHas(A.page, '3');
await pillHas(B.page, '3');
await pillHas(D.page, '3');
await A.page.click('[data-action=closeLink]');
await B.page.click('[data-action=closeLink]');
await D.page.click('[data-action=closeLink]');
step('troisième appareil rejoint depuis le lien, sans copier-coller');

assert.doesNotMatch(await chat(A.page), /Je traverse actuellement/, 'la conversation reliée repart de zéro');

// ---- échanges à trois
await A.page.fill('#message-input', 'Bonjour Bob, secret-alpha');
await A.page.press('#message-input', 'Enter');
await B.page.waitForFunction(() => document.getElementById('chat').innerText.includes('secret-alpha'));
await D.page.waitForFunction(() => document.getElementById('chat').innerText.includes('secret-alpha'));
await B.page.fill('#message-input', 'Salut Alice');
await B.page.click('#send-btn');
await A.page.waitForFunction(() => document.getElementById('chat').innerText.includes('Salut Alice'));
await D.page.fill('#message-input', 'Coucou de Dan');
await D.page.click('#send-btn');
await A.page.waitForFunction(() => document.getElementById('chat').innerText.includes('Coucou de Dan'));
await B.page.waitForFunction(() => document.getElementById('chat').innerText.includes('Coucou de Dan'));
await shot(A.page, '05-sync-chat-A');
await shot(B.page, '06-sync-chat-B-light');
assert.equal(await A.page.locator('.msg.mine', { hasText: 'secret-alpha' }).count(), 1);
assert.match(await B.page.locator('.msg.theirs', { hasText: 'Coucou de Dan' }).innerText(), /Dan/, 'le nom de l\'auteur est affiché');
step('messages entre trois appareils, auteurs corrects (relayés par l\'hôte)');

// ---- suppression : seulement ses propres messages, répercutée chez tous
assert.equal(await B.page.locator('.msg', { hasText: 'secret-alpha' }).locator('.del-btn').count(), 0);
await A.page.locator('.msg', { hasText: 'secret-alpha' }).locator('.del-btn').click();
await B.page.waitForFunction(() => !document.getElementById('chat').innerText.includes('secret-alpha'));
await D.page.waitForFunction(() => !document.getElementById('chat').innerText.includes('secret-alpha'));
step('suppression synchronisée (uniquement ses propres messages)');

// ---- export désactivé pendant une conversation reliée
await A.page.click('#btn-share');
await A.page.waitForFunction(() => /Export désactivé/.test(document.getElementById('toast-text').textContent));
assert.equal(await A.page.locator('#share-dlg[open]').count(), 0);
step('export désactivé en conversation reliée');

// ---- rien d'enregistré
for (const { page } of [A, B, D]) {
    const dump = await page.evaluate(() => JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage)));
    assert.doesNotMatch(dump, /Salut Alice|Bonjour Bob|Coucou de Dan/, 'aucun message ne doit être stocké');
}
step('aucun message dans le stockage du navigateur');

// ---- bouclier : masque l'écran quand la page n'est plus visible
const hide = (page, v) => page.evaluate((hidden) => {
    if (hidden) Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    else delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
}, v);
await hide(A.page, true);
assert.equal(await A.page.locator('#shield').isVisible(), true);
await shot(A.page, '07-shield');
await hide(A.page, false);
assert.equal(await A.page.locator('#shield').isVisible(), false);
step('bouclier de confidentialité');

// ---- fin de conversation par l'hôte : tout s'efface chez tout le monde
await A.page.click('#status-pill');
await A.page.click('#live-end');
await A.page.click('#confirm-yes');
for (const { page } of [A, B, D]) {
    await page.waitForFunction(() => document.body.dataset.mode === 'local', null, { timeout: 10000 });
    assert.doesNotMatch(await chat(page), /Salut Alice|Bonjour Bob|secret-alpha|Coucou de Dan/);
    assert.equal(await page.locator('.msg.theirs').count(), 0, 'aucun message de l\'autre appareil ne doit rester');
    assert.equal(await state(page), 'local');
}
await shot(B.page, '08-ended');
step('fin de conversation : messages effacés sur les trois appareils, retour au mode local');

// ---- hors ligne : l'application se recharge sans réseau
await B.page.evaluate(() => navigator.serviceWorker.ready);
await B.page.waitForFunction(async () => (await caches.keys()).length > 0);
await B.ctx.setOffline(true);
await B.page.reload();
await B.page.waitForSelector('#chat');
assert.ok(await B.page.locator('#status-pill').isVisible());
step('rechargement hors ligne');
await B.ctx.setOffline(false);

await browser.close();
server.close();
if (errors.length) { console.error('ERREURS NAVIGATEUR:\n' + errors.join('\n')); process.exit(1); }
console.log('e2e-sync : OK');
