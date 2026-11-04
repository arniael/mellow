import { KEYS, rawGet, rawSet, rawDel, jsonGet, jsonSet } from './storage.js';
import { I18N } from './i18n.js';
import { createLink } from './link.js';
import { drawQR, canScan, startScan } from './qr.js';

const OWNER = 'me';
const OTHER = 'other';
const LOST_WIPE_MS = 10 * 60 * 1000;
const LOCALE_TAGS = { fr: 'fr-FR', en: 'en-US' };
const FONT_SCALE = { small: 0.9, normal: 1, large: 1.2, xl: 1.45 };
const THEME_COLORS = { dark: '#16151c', light: '#f4f3f8', contrast: '#000000', soft: '#ebe7df' };

const DEFAULTS = {
    name: '', theme: 'dark', lang: 'auto', fontSize: 'normal',
    popupMsg: '', autoMsgEnabled: true, autoMsgIsCustom: false, autoMsgContent: '',
    saveHistory: false, quickEnabled: true, quickPhrases: '',
    partnerFocus: false, reduceMotion: false, vibrate: false, autoSpeak: false,
    shield: true, holdToRead: false
};

const $ = (id) => document.getElementById(id);
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

const baseUrl = () => location.href.split('#')[0].split('?')[0];
const inviteUrl = (code) => baseUrl() + '#' + code;
const CODE_RE = /SM1[oa][A-Za-z0-9_-]+/;
const extractCode = (str) => {
    const raw = String(str || '');
    const direct = raw.match(CODE_RE);
    if (direct && direct[0].length > 60) return direct[0];
    const joined = raw.replace(/\s+/g, '');
    const m = joined.match(CODE_RE);
    return m ? m[0] : joined;
};

let config = loadConfig();
let mode = 'local';
let localMsgs = [];
let syncMsgs = [];
let isOwnerTurn = true;
let isFirstRun = !rawGet(KEYS.tutorial);
const selfId = newId();
let link = null;
let peers = new Map();
let pendingHost = null;
let linkLost = false;
let lostTimer = null, toastTimer = null, saveTimer = null;
let toastAction = null, confirmResolver = null, undoBackup = null;
let stopScan = null, scanTarget = null;
let recognition = null, listening = false;
let pendingInvite = null, quietStart = false, pairChannel = null, waitingAck = null;
const rendered = new Set();

function loadConfig() {
    let saved = jsonGet(KEYS.config, {});
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    const cfg = Object.assign({}, DEFAULTS, saved);
    if (Object.keys(I18N).some((l) => I18N[l]['popup.default'] === cfg.popupMsg)) cfg.popupMsg = '';
    if (!THEME_COLORS[cfg.theme]) cfg.theme = 'dark';
    return cfg;
}
const saveConfig = () => jsonSet(KEYS.config, config);

function lang() {
    if (config.lang && config.lang !== 'auto' && I18N[config.lang]) return config.lang;
    const n = (navigator.language || 'fr').slice(0, 2).toLowerCase();
    return I18N[n] ? n : 'en';
}
const locale = () => LOCALE_TAGS[lang()] || 'en-US';
function t(key, params) {
    let s = (I18N[lang()] || {})[key];
    if (s === undefined) s = I18N.fr[key];
    if (s === undefined) return key;
    if (params) for (const k in params) s = s.split('{' + k + '}').join(params[k]);
    return s;
}
function applyI18n() {
    document.documentElement.lang = lang();
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
        const label = t(el.dataset.i18nAria);
        el.setAttribute('aria-label', label);
        if (el.tagName === 'BUTTON') el.title = label;
    });
}

function applyAppearance() {
    const root = document.documentElement;
    root.setAttribute('data-theme', config.theme);
    root.setAttribute('data-motion', config.reduceMotion ? 'off' : 'on');
    root.style.setProperty('--fs', FONT_SCALE[config.fontSize] || 1);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[config.theme]);
}

function newId() {
    const a = new Uint8Array(9);
    (globalThis.crypto || window.crypto).getRandomValues(a);
    return Array.prototype.map.call(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const myId = () => (mode === 'sync' ? selfId : OWNER);
const msgs = () => (mode === 'sync' ? syncMsgs : localMsgs);
const persistLocal = () => { if (config.saveHistory) jsonSet(KEYS.history, localMsgs); };
function buzz(ms) { if (config.vibrate && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* ignore */ } } }
const defaultPhrases = () => t('quick.defaults');
function getPhrases() {
    const src = config.quickPhrases && config.quickPhrases.trim() ? config.quickPhrases : defaultPhrases();
    return src.split('\n').map((s) => s.trim()).filter(Boolean);
}
function make(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function openModal(id) {
    const d = $(id);
    if (!d.open) d.showModal();
    return d;
}
function closeModal(id) { const d = $(id); if (d.open) d.close(); }
const isOpen = (id) => $(id).open;

function hideToast() {
    const toast = $('toast');
    toast.classList.remove('show');
    try { if (toast.matches(':popover-open')) toast.hidePopover(); } catch (e) { /* ignore */ }
}

function showToast(msg, opts) {
    opts = opts || {};
    $('toast-text').textContent = msg;
    const btn = $('toast-action');
    btn.hidden = !opts.actionLabel;
    btn.textContent = opts.actionLabel || '';
    toastAction = opts.onAction || null;
    const toast = $('toast');
    toast.style.bottom = ($('composer').offsetHeight + 16) + 'px';
    try { if (!toast.matches(':popover-open')) toast.showPopover(); } catch (e) { /* ancien navigateur */ }
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, opts.duration || 2800);
}

function confirmDialog(message, okLabel) {
    return new Promise((resolve) => {
        confirmResolver = resolve;
        $('confirm-text').textContent = message;
        $('confirm-yes').textContent = okLabel || t('confirm');
        openModal('confirm-dlg');
    });
}
function resolveConfirm(v) {
    const r = confirmResolver;
    confirmResolver = null;
    closeModal('confirm-dlg');
    if (r) r(v);
}

function canDelete(m) {
    if (mode === 'sync') return m.from === selfId;
    if (isOwnerTurn) return (m.from === OWNER && !m.locked) || m.vocal;
    return m.from === OTHER && !m.locked && !m.vocal;
}

function visibleMessages() {
    const list = msgs();
    if (mode === 'local' && !isOwnerTurn && config.partnerFocus) {
        let start = 0;
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].from === OTHER && list[i].locked) { start = i + 1; break; }
        }
        return list.slice(start);
    }
    return list;
}

function buildMessage(m) {
    const mine = m.from === myId();
    const div = make('div', 'msg ' + (mine ? 'mine' : 'theirs') + (rendered.has(m.id) ? '' : ' fresh'));
    rendered.add(m.id);
    if (mode === 'sync' && !mine) div.appendChild(make('div', 'msg-author', peers.get(m.from) || t('chat.someone')));

    const body = make('div', 'msg-text');
    if (m.vocal) body.appendChild(make('i', '', '[' + t('chat.vocal') + ']'));
    else body.textContent = m.text;
    div.appendChild(body);

    const foot = make('div', 'msg-foot');
    if (mode === 'local' && mine && !m.vocal && m.text && 'speechSynthesis' in window) {
        const sp = make('button', 'speak-btn', '🔊');
        sp.type = 'button';
        sp.title = sp.ariaLabel = t('chat.speak');
        sp.dataset.action = 'speakMsg';
        sp.dataset.id = m.id;
        foot.appendChild(sp);
    }
    foot.appendChild(make('span', 'msg-time', m.time || fmtTime(m.ts)));
    div.appendChild(foot);

    if (canDelete(m)) {
        const del = make('button', 'del-btn', '×');
        del.type = 'button';
        del.ariaLabel = del.title = t('chat.delete');
        del.dataset.action = 'deleteMsg';
        del.dataset.id = m.id;
        div.appendChild(del);
    }
    return div;
}

function render() {
    const c = $('chat');
    c.classList.toggle('focus', mode === 'local' && !isOwnerTurn && config.partnerFocus);
    c.classList.toggle('hold', !!config.holdToRead);
    const list = visibleMessages();
    c.textContent = '';
    if (!list.length) c.appendChild(make('p', 'empty', t(mode === 'sync' ? 'chat.emptySync' : 'chat.empty')));
    list.forEach((m) => c.appendChild(buildMessage(m)));
    c.scrollTop = c.scrollHeight;
}

function addLocal(text, from, vocal) {
    const ts = Date.now();
    localMsgs.push({ id: newId(), from, text, ts, time: fmtTime(ts), locked: false, vocal: !!vocal });
    persistLocal();
    render();
}

function sendText(text, fromQuick) {
    if (mode === 'sync') {
        if (!link || !link.isOpen()) { showToast(t('toast.notConnected')); return false; }
        const m = { id: newId(), from: selfId, text, ts: Date.now(), vocal: false };
        syncMsgs.push(m);
        link.send({ t: 'msg', id: m.id, from: m.from, text: m.text, ts: m.ts, vocal: false });
        render();
    } else {
        const from = isOwnerTurn ? OWNER : OTHER;
        addLocal(text, from, false);
        if (from === OWNER && config.autoSpeak) speak(text);
    }
    buzz(20);
    if (fromQuick) $('message-input').focus();
    return true;
}

function sendMessage() {
    const input = $('message-input');
    const text = input.value.trim();
    if (!text) return;
    if (sendText(text)) { input.value = ''; input.focus(); }
}

function deleteMessage(id) {
    const m = msgs().find((x) => x.id === id);
    if (!m || !canDelete(m)) return;
    if (mode === 'sync') {
        syncMsgs = syncMsgs.filter((x) => x.id !== id);
        if (link) link.send({ t: 'del', id });
    } else {
        localMsgs = localMsgs.filter((x) => x.id !== id);
        persistLocal();
    }
    render();
}

function triggerWelcomeMessage() {
    if (!config.autoMsgEnabled) return;
    let text;
    if (config.autoMsgIsCustom && config.autoMsgContent) text = config.autoMsgContent;
    else text = t('welcome.msg', { greeting: config.name ? t('greet.named', { name: config.name }) : t('greet.anon') });
    if (text) addLocal(text, OWNER, false);
}

function toggleUser() {
    if (mode !== 'local') return;
    stopListening();
    localMsgs.forEach((m) => { m.locked = true; });
    persistLocal();
    isOwnerTurn = !isOwnerTurn;
    buzz(40);
    updateUI();
    render();
}

function statusState() {
    if (mode === 'local') return 'local';
    if (linkLost) return 'lost';
    return peers.size > 0 ? 'live' : 'waiting';
}

function updateUI() {
    const state = statusState();
    document.body.dataset.mode = mode;
    document.body.dataset.turn = isOwnerTurn ? 'owner' : 'partner';
    if (canScan()) document.body.dataset.canScan = '1';

    $('status-pill').dataset.state = state;
    $('status-text').textContent = state === 'live' ? t('status.live', { n: peers.size + 1 }) : t('status.' + state);

    const nameStr = config.name ? ', ' + config.name : '';
    $('turn-banner').textContent = isOwnerTurn ? t('turn.owner', { name: nameStr }) : t('turn.partner');
    $('switch-btn').textContent = isOwnerTurn ? t('btn.pass') : (config.name ? t('btn.giveBackNamed', { name: config.name }) : t('btn.giveBack'));
    $('vocal-btn').hidden = !(mode === 'local' && isOwnerTurn);
    $('listen-btn').hidden = !(mode === 'local' && isOwnerTurn && SpeechRec);
    $('listen-btn').textContent = listening ? t('btn.listening') : t('btn.listen');
    $('listen-btn').classList.toggle('active', listening);

    renderQuickPhrases();
    updateShield();
}

function renderQuickPhrases() {
    const box = $('quick-phrases');
    const phrases = getPhrases();
    const show = (mode === 'sync' || isOwnerTurn) && config.quickEnabled && phrases.length > 0;
    box.hidden = !show;
    box.textContent = '';
    if (!show) return;
    phrases.forEach((p, i) => {
        const b = make('button', 'chip', p);
        b.type = 'button';
        b.dataset.action = 'quick';
        b.dataset.index = String(i);
        box.appendChild(b);
    });
}

function updateShield() {
    const hidden = document.hidden || !document.hasFocus();
    $('shield').hidden = !(config.shield && mode === 'sync' && hidden);
}

function speak(text) {
    if (!('speechSynthesis' in window)) { showToast(t('toast.noSpeech')); return; }
    try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = locale();
        window.speechSynthesis.speak(u);
    } catch (e) { showToast(t('toast.noSpeech')); }
}
function stopListening() {
    if (recognition && listening) { try { recognition.stop(); } catch (e) { /* ignore */ } }
    listening = false;
}
function toggleListen() {
    if (!SpeechRec || mode !== 'local' || !isOwnerTurn) return;
    if (listening) { stopListening(); updateUI(); return; }
    try {
        recognition = new SpeechRec();
        recognition.lang = locale();
        recognition.interimResults = false;
        recognition.onresult = (e) => {
            const txt = Array.prototype.map.call(e.results, (r) => r[0].transcript).join(' ').trim();
            if (txt) { addLocal(txt, OTHER, false); buzz(20); }
        };
        recognition.onerror = () => showToast(t('toast.micError'));
        recognition.onend = () => { listening = false; updateUI(); };
        recognition.start();
        listening = true;
    } catch (e) { listening = false; showToast(t('toast.micError')); }
    updateUI();
}

function buildExportText() {
    const me = config.name || t('export.me');
    let out = t('export.header', { date: new Date().toLocaleDateString(locale()) }) + '\n\n';
    localMsgs.forEach((m) => {
        const who = m.from === OWNER ? me : t('export.other');
        out += '[' + (m.time || fmtTime(m.ts)) + '] ' + who + ' : ' + (m.vocal ? t('export.vocal') : m.text) + '\n';
    });
    return out;
}
function openShare() {
    if (mode === 'sync') { showToast(t('toast.noExport')); return; }
    if (!isOwnerTurn) return;
    if (!localMsgs.length) { showToast(t('toast.nothing')); return; }
    $('share-native').hidden = !navigator.share;
    openModal('share-dlg');
}
function shareNative() {
    closeModal('share-dlg');
    navigator.share({ title: 'SafeMode', text: buildExportText() }).catch(() => {});
}
function shareCopy() {
    closeModal('share-dlg');
    const fail = () => showToast(t('toast.copyFail'));
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(buildExportText()).then(() => showToast(t('toast.copied')), fail);
    else fail();
}
function shareDownload() {
    closeModal('share-dlg');
    const url = URL.createObjectURL(new Blob([buildExportText()], { type: 'text/plain;charset=utf-8' }));
    const a = make('a');
    a.href = url;
    a.download = 'mellow-' + new Date().toISOString().slice(0, 10) + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearChat() {
    if (mode !== 'local' || !isOwnerTurn) return;
    undoBackup = localMsgs.slice();
    localMsgs = [];
    rawDel(KEYS.history);
    triggerWelcomeMessage();
    persistLocal();
    closeModal('config-dlg');
    render();
    showToast(t('toast.cleared'), {
        actionLabel: t('toast.undo'), duration: 6000,
        onAction: () => {
            if (!undoBackup) return;
            localMsgs = undoBackup;
            undoBackup = null;
            persistLocal();
            render();
            showToast(t('toast.restored'));
        }
    });
}

const handlers = {
    getHistory: () => syncMsgs.map((m) => ({ id: m.id, from: m.from, text: m.text, ts: m.ts, vocal: m.vocal })),
    onJoin: ({ id, name, resumed }) => {
        peers.set(id, name);
        setLinkLost(false);
        updateUI();
        render();
        if (pendingHost) pendingHost = null;
        if (isOpen('link-dlg')) showLiveView();
        showToast(t('toast.joined', { name: name || t('chat.someone') }));
        buzz(30);
        if (resumed) render();
    },
    onRoster: (list) => {
        peers = new Map();
        list.forEach((p) => { if (p.id !== selfId) peers.set(p.id, p.name); });
        updateUI();
        render();
        if (isOpen('link-dlg')) showLiveView();
    },
    onLeave: (id) => {
        const name = peers.get(id);
        peers.delete(id);
        updateUI();
        render();
        if (isOpen('link-dlg') && $('lv-live').hidden === false) showLiveView();
        showToast(t('toast.left', { name: name || t('chat.someone') }));
    },
    onMessage: (m) => {
        if (syncMsgs.some((x) => x.id === m.id)) return false;
        syncMsgs.push({ id: m.id, from: m.from, text: m.text, ts: m.ts, vocal: m.vocal });
        render();
        buzz(30);
        return true;
    },
    onDelete: (id, by) => {
        const i = syncMsgs.findIndex((x) => x.id === id);
        if (i < 0) return false;
        if (by && syncMsgs[i].from !== by) return false;
        syncMsgs.splice(i, 1);
        render();
        return true;
    },
    onSync: (list) => {
        let added = false;
        list.forEach((m) => {
            if (!syncMsgs.some((x) => x.id === m.id)) { syncMsgs.push({ id: m.id, from: m.from, text: m.text, ts: m.ts, vocal: m.vocal }); added = true; }
        });
        if (added) { syncMsgs.sort((a, b) => a.ts - b.ts); render(); }
    },
    onLost: () => { setLinkLost(true); showToast(t('toast.lost')); },
    onEnded: () => wipeSync('ended')
};

function setLinkLost(v) {
    linkLost = v;
    clearTimeout(lostTimer);
    if (v) lostTimer = setTimeout(() => wipeSync('timeout'), LOST_WIPE_MS);
    updateUI();
}

function beginSync(role) {
    const l = createLink({ role, selfId, getName: () => config.name, sid: role === 'host' ? newId() : null }, handlers);
    return l;
}

function enterSync(l) {
    link = l;
    mode = 'sync';
    syncMsgs = [];
    peers = new Map();
    linkLost = false;
    rendered.clear();
    document.body.classList.add('is-sync');
    updateUI();
    render();
}

function wipeSync(reason) {
    const l = link;
    link = null;
    pendingHost = null;
    stopScanner();
    clearTimeout(lostTimer);
    if (l) { if (reason === 'self') l.end(); else l.close(); }
    syncMsgs = [];
    peers = new Map();
    linkLost = false;
    mode = 'local';
    rendered.clear();
    $('message-input').value = '';
    ['host-code', 'host-answer', 'guest-offer', 'guest-code'].forEach((id) => { $(id).value = ''; });
    ['host-qr', 'guest-qr'].forEach((id) => { const c = $(id); c.width = 10; c.height = 10; });
    closeModal('link-dlg');
    updateUI();
    render();
    if (reason !== 'cancel') showToast(t('toast.wiped.' + reason));
}

function showView(name) {
    ['lv-home', 'lv-host', 'lv-guest', 'lv-live'].forEach((id) => { $(id).hidden = id !== 'lv-' + name; });
    stopScanner();
}

function showLiveView() {
    showView('live');
    const list = $('peer-list');
    list.textContent = '';
    list.appendChild(make('li', 'me', config.name ? t('link.me', { name: config.name }) : t('link.meAnon')));
    peers.forEach((name) => list.appendChild(make('li', '', name || t('chat.someone'))));
    $('live-title').textContent = peers.size ? t('link.connectedTo', { n: peers.size + 1 }) : t('link.nobody');
    const host = link && link.role === 'host';
    $('live-add').hidden = !host;
    $('live-end').textContent = host ? t('link.endAll') : t('link.leave');
}

function openLink() {
    if (mode === 'local' && !isOwnerTurn) return;
    openModal('link-dlg');
    if (mode === 'local') showView('home');
    else if (pendingHost) showView('host');
    else showLiveView();
}

function errorText(e) {
    const m = e && e.message;
    return t(m === 'bad-code' ? 'link.errCode' : m === 'wrong-kind' ? 'link.errKind' : 'link.errGeneric');
}

async function hostPrepare() {
    showView('host');
    $('host-error').hidden = true;
    $('host-answer').value = '';
    $('host-code').value = '';
    $('host-wait').hidden = false;
    try {
        const { handle, code } = await link.hostCreateOffer();
        pendingHost = handle;
        const url = inviteUrl(code);
        $('host-code').value = url;
        drawQR($('host-qr'), url);
        $('host-wait').hidden = true;
    } catch (e) {
        $('host-error').textContent = errorText(e);
        $('host-error').hidden = false;
    }
}

async function linkHost() {
    if (mode === 'local') {
        if (!window.RTCPeerConnection) { showToast(t('link.noRtc')); return; }
        enterSync(beginSync('host'));
    }
    await hostPrepare();
}

async function hostConnect() {
    const code = extractCode($('host-answer').value);
    if (!code || !pendingHost) return;
    $('host-error').hidden = true;
    try {
        await link.hostAcceptAnswer(pendingHost, code);
        $('host-answer').value = '';
    } catch (e) {
        $('host-error').textContent = errorText(e);
        $('host-error').hidden = false;
    }
}

function linkGuest() {
    if (!window.RTCPeerConnection) { showToast(t('link.noRtc')); return; }
    showView('guest');
    $('guest-step1').hidden = false;
    $('guest-step2').hidden = true;
    $('guest-error').hidden = true;
    $('guest-offer').value = '';
}

async function guestContinue() {
    const code = extractCode($('guest-offer').value);
    if (!code) return;
    $('guest-error').hidden = true;
    const fresh = !link;
    const l = link || beginSync('guest');
    try {
        const { code: answer } = await l.guestJoin(code);
        if (fresh) enterSync(l);
        const url = inviteUrl(answer);
        $('guest-code').value = url;
        drawQR($('guest-qr'), url);
        $('guest-step1').hidden = true;
        $('guest-step2').hidden = false;
    } catch (e) {
        if (fresh) l.close();
        $('guest-error').textContent = errorText(e);
        $('guest-error').hidden = false;
    }
}

function linkCancel() {
    if (link && link.role === 'host' && link.peerCount() > 0) { link.cancelPending(); pendingHost = null; showLiveView(); return; }
    if (link && link.peerCount() > 0) { showLiveView(); return; }
    wipeSync('cancel');
}

async function linkAdd() { if (link) await hostPrepare(); }

async function endSession() {
    const host = link && link.role === 'host';
    const ok = await confirmDialog(t(host ? 'link.confirmEnd' : 'link.confirmLeave'), t('link.yesErase'));
    if (ok) wipeSync('self');
}

function closeLink() {
    stopScanner();
    closeModal('link-dlg');
}

/* ---- Lecture de QR ---- */
function stopScanner() {
    if (stopScan) { stopScan(); stopScan = null; }
    $('scan-box').hidden = true;
}
async function scan(targetId) {
    scanTarget = targetId;
    $('scan-box').hidden = false;
    stopScan = await startScan($('scan-video'), (text) => {
        $('scan-box').hidden = true;
        stopScan = null;
        $(scanTarget).value = text;
        if (scanTarget === 'host-answer') hostConnect();
        else guestContinue();
    }, () => { $('scan-box').hidden = true; stopScan = null; showToast(t('toast.camError')); });
}

function shareLink(id) { navigator.share({ title: 'SafeMode', url: $(id).value }).catch(() => {}); }

async function copyCode(id) {
    const v = $(id).value;
    try { await navigator.clipboard.writeText(v); showToast(t('toast.codeCopied')); }
    catch (e) { $(id).select(); showToast(t('toast.copyFail')); }
}

function updateSubSettings() {
    $('quick-options').hidden = !$('cfg-quick-on').checked;
    const enabled = $('cfg-automsg').checked;
    const custom = $('cfg-automsg-custom').checked;
    $('auto-msg-options').hidden = !enabled;
    $('cfg-automsg-content').hidden = !custom;
    const preview = $('default-msg-preview');
    preview.hidden = custom;
    if (!custom) {
        const n = $('cfg-name').value.trim();
        preview.textContent = t('settings.autoMsgPreview', { greeting: n ? t('greet.named', { name: n }) : t('greet.anon') });
    }
}
function updatePinUI() {
    const has = !!rawGet(KEYS.pin);
    $('pin-status').textContent = t(has ? 'settings.pinOn' : 'settings.pinOff');
    $('pin-remove').hidden = !has;
}
function fillSettings() {
    $('cfg-name').value = config.name;
    $('cfg-lang').value = config.lang;
    $('cfg-theme').value = config.theme;
    $('cfg-font').value = config.fontSize;
    $('cfg-focus').checked = config.partnerFocus;
    $('cfg-motion').checked = config.reduceMotion;
    $('cfg-vibrate').checked = config.vibrate;
    $('cfg-speak').checked = config.autoSpeak;
    $('cfg-quick-on').checked = config.quickEnabled;
    $('cfg-quick').value = config.quickPhrases || defaultPhrases();
    $('cfg-automsg').checked = config.autoMsgEnabled;
    $('cfg-automsg-custom').checked = config.autoMsgIsCustom;
    $('cfg-automsg-content').value = config.autoMsgContent;
    $('cfg-popup').value = config.popupMsg || t('popup.default');
    $('cfg-shield').checked = config.shield;
    $('cfg-hold').checked = config.holdToRead;
    $('cfg-save').checked = config.saveHistory;
    $('cfg-pin').value = '';
    updateSubSettings();
    updatePinUI();
}

function autoSave() {
    const prevLang = lang();
    const prevSave = config.saveHistory;
    config.name = $('cfg-name').value.trim();
    config.lang = $('cfg-lang').value;
    config.theme = $('cfg-theme').value;
    config.fontSize = $('cfg-font').value;
    config.partnerFocus = $('cfg-focus').checked;
    config.reduceMotion = $('cfg-motion').checked;
    config.vibrate = $('cfg-vibrate').checked;
    config.autoSpeak = $('cfg-speak').checked;
    config.quickEnabled = $('cfg-quick-on').checked;
    config.autoMsgEnabled = $('cfg-automsg').checked;
    config.autoMsgIsCustom = $('cfg-automsg-custom').checked;
    config.autoMsgContent = $('cfg-automsg-content').value;
    config.shield = $('cfg-shield').checked;
    config.holdToRead = $('cfg-hold').checked;
    config.saveHistory = $('cfg-save').checked;
    const popup = $('cfg-popup').value;
    config.popupMsg = popup === t('popup.default') || !popup.trim() ? '' : popup;
    const quick = $('cfg-quick').value;
    config.quickPhrases = quick === defaultPhrases() || !quick.trim() ? '' : quick;

    if (config.saveHistory !== prevSave) {
        if (config.saveHistory) { persistLocal(); showToast(t('toast.historyOn')); } else rawDel(KEYS.history);
    }
    saveConfig();
    applyAppearance();
    applyI18n();
    if (lang() !== prevLang) {
        if (!config.popupMsg) $('cfg-popup').value = t('popup.default');
        if (!config.quickPhrases) $('cfg-quick').value = defaultPhrases();
    }
    updateSubSettings();
    updatePinUI();
    updateUI();
    render();
    const flag = $('saved-flag');
    flag.style.opacity = '1';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { flag.style.opacity = '0'; }, 2500);
}

function openConfig() {
    if (mode === 'local' && !isOwnerTurn) return;
    fillSettings();
    openModal('config-dlg');
}

async function resetConfig() {
    if (!isOwnerTurn) return;
    if (!(await confirmDialog(t('confirm.reset')))) return;
    config = Object.assign({}, DEFAULTS);
    saveConfig();
    rawDel(KEYS.history);
    applyAppearance();
    applyI18n();
    fillSettings();
    updateUI();
    render();
    showToast(t('toast.reset'));
}

async function hashPin(pin) {
    try {
        if (crypto.subtle) {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mellow:' + pin));
            return Array.prototype.map.call(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
        }
    } catch (e) { /* repli */ }
    let h = 5381;
    const s = 'mellow:' + pin;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'x' + h;
}
async function setPin() {
    const v = $('cfg-pin').value.trim();
    if (!/^\d{4,6}$/.test(v)) { showToast(t('pin.invalid')); return; }
    rawSet(KEYS.pin, await hashPin(v));
    $('cfg-pin').value = '';
    updatePinUI();
    showToast(t('pin.saved'));
}
function removePin() { rawDel(KEYS.pin); updatePinUI(); showToast(t('pin.removed')); }
async function unlock() {
    const v = $('lock-input').value.trim();
    if ((await hashPin(v)) === rawGet(KEYS.pin)) {
        $('lock-input').value = '';
        $('lock-error').hidden = true;
        closeModal('lock-dlg');
        startSession();
    } else {
        $('lock-error').hidden = false;
        $('lock-input').select();
    }
}

function openInfo() {
    $('info-content').textContent = config.popupMsg || t('popup.default');
    openModal('info-dlg');
}
function aboutStart() {
    closeModal('about-dlg');
    if (isFirstRun) {
        rawSet(KEYS.tutorial, 'true');
        isFirstRun = false;
        if (!localMsgs.length) { triggerWelcomeMessage(); if (pendingInvite) runInvite(); else openInfo(); }
        else if (pendingInvite) runInvite();
    }
}
function welcomeNext() {
    config.name = $('welcome-name').value.trim();
    saveConfig();
    closeModal('welcome-dlg');
    updateUI();
    openModal('about-dlg');
}

const actions = {
    openInfo, closeInfo: () => closeModal('info-dlg'),
    openAbout: () => openModal('about-dlg'), closeAbout: () => closeModal('about-dlg'), aboutStart,
    openConfig, closeConfig: () => closeModal('config-dlg'),
    openLink, closeLink, linkHost, linkGuest, guestContinue, hostConnect, linkCancel, linkAdd, endSession,
    copyHostCode: () => copyCode('host-code'), copyGuestCode: () => copyCode('guest-code'),
    shareHostLink: () => shareLink('host-code'), shareGuestLink: () => shareLink('guest-code'),
    scanAnswer: () => scan('host-answer'), scanOffer: () => scan('guest-offer'), scanStop: stopScanner,
    share: openShare, closeShare: () => closeModal('share-dlg'), shareNative, shareCopy, shareDownload,
    send: sendMessage, switch: toggleUser, vocal: () => { addLocal('', OTHER, true); buzz(20); }, listen: toggleListen,
    clear: clearChat, reset: resetConfig, welcomeNext, pinSet: setPin, pinRemove: removePin, unlock,
    confirmYes: () => resolveConfirm(true), confirmNo: () => resolveConfirm(false),
    toastAction: () => { const fn = toastAction; hideToast(); if (fn) fn(); },
    deleteMsg: (e, el) => deleteMessage(el.dataset.id),
    speakMsg: (e, el) => { const m = localMsgs.find((x) => x.id === el.dataset.id); if (m) speak(m.text); },
    quick: (e, el) => { const p = getPhrases()[Number(el.dataset.index)]; if (p) sendText(p, true); }
};

function bindEvents() {
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (el && actions[el.dataset.action]) actions[el.dataset.action](e, el);
    });

    document.querySelectorAll('dialog.sheet').forEach((d) => {
        d.addEventListener('click', (e) => { if (e.target === d && d.id !== 'welcome-dlg' && d.id !== 'lock-dlg') d.close(); });
        d.addEventListener('cancel', (e) => { if (d.id === 'welcome-dlg' || d.id === 'lock-dlg') e.preventDefault(); });
    });
    $('confirm-dlg').addEventListener('close', () => { if (confirmResolver) resolveConfirm(false); });
    $('link-dlg').addEventListener('close', stopScanner);

    $('message-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendMessage(); } });
    $('lock-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
    $('welcome-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') welcomeNext(); });

    const cfg = $('config-dlg');
    const onChange = (e) => { if (!(e.target.dataset && e.target.dataset.nosave)) autoSave(); };
    cfg.addEventListener('input', onChange);
    cfg.addEventListener('change', onChange);

    // Lecture « maintenir pour lire »
    const chat = $('chat');
    const reveal = (v) => chat.classList.toggle('reveal', v);
    chat.addEventListener('pointerdown', () => reveal(true));
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((n) => chat.addEventListener(n, () => reveal(false)));
    chat.addEventListener('contextmenu', (e) => { if (config.holdToRead || mode === 'sync') e.preventDefault(); });

    // Bouclier + effacement de sécurité
    ['visibilitychange', 'blur', 'focus', 'pageshow'].forEach((n) => (n === 'visibilitychange' ? document : window).addEventListener(n, updateShield));
    window.addEventListener('pagehide', (e) => { if (!e.persisted && mode === 'sync' && link) { try { link.end(); } catch (err) { /* ignore */ } } });
}

function loadHistory() {
    if (!config.saveHistory) { rawDel(KEYS.history); localMsgs = []; return; }
    const saved = jsonGet(KEYS.history, []);
    localMsgs = (Array.isArray(saved) ? saved : []).filter((m) => m && typeof m === 'object').map((m) => {
        const from = m.from || (m.type === 'partner' ? OTHER : OWNER);
        return {
            id: typeof m.id === 'string' && m.id ? m.id : newId(),
            from: from === OTHER ? OTHER : OWNER,
            text: typeof m.text === 'string' ? m.text : '',
            ts: Number.isFinite(m.ts) ? m.ts : Date.now(),
            time: typeof m.time === 'string' ? m.time : '',
            locked: m.locked !== undefined ? !!m.locked : true,
            vocal: !!(m.vocal || m.isVocal || (m.text && m.text.indexOf('[Réponse vocale]') !== -1))
        };
    });
}

function startSession() {
    loadHistory();
    render();
    updateUI();
    if (isFirstRun) { openModal('welcome-dlg'); return; }
    if (!localMsgs.length) triggerWelcomeMessage();
    if (pendingInvite) { runInvite(); return; }
    if (!quietStart && (!config.saveHistory || localMsgs.length <= 1)) openInfo();
}

function readInvite() {
    const m = location.hash.match(/^#(SM1[oa][A-Za-z0-9_-]+)$/);
    if (!m) return null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    return m[1];
}

async function runInvite() {
    const code = pendingInvite;
    pendingInvite = null;
    if (!code) return;
    if (mode === 'sync') { showToast(t('invite.busy')); return; }
    openModal('link-dlg');
    linkGuest();
    $('guest-offer').value = code;
    await guestContinue();
}

function handOffAnswer(code) {
    quietStart = true;
    if (!pairChannel) { showToast(t('invite.noHost'), { duration: 9000 }); return; }
    const timer = setTimeout(() => { waitingAck = null; showToast(t('invite.noHost'), { duration: 9000 }); }, 1500);
    waitingAck = () => { clearTimeout(timer); waitingAck = null; showToast(t('invite.sent'), { duration: 9000 }); try { window.close(); } catch (e) { /* ignore */ } };
    pairChannel.postMessage({ t: 'answer', code });
}


function init() {
    applyAppearance();
    applyI18n();
    bindEvents();
    ['host-share', 'guest-share'].forEach((id) => { $(id).hidden = !navigator.share; });
    try { pairChannel = new BroadcastChannel('mellow-pair'); } catch (e) { pairChannel = null; }
    if (pairChannel) {
        pairChannel.onmessage = (e) => {
            const d = e.data || {};
            if (d.t === 'answer' && typeof d.code === 'string' && link && link.role === 'host' && pendingHost) {
                pairChannel.postMessage({ t: 'ack' });
                if (!isOpen('link-dlg')) openLink();
                $('host-answer').value = d.code;
                hostConnect();
            } else if (d.t === 'ack' && waitingAck) waitingAck();
        };
    }
    const invite = readInvite();
    if (invite && invite[3] === 'a') handOffAnswer(invite); else pendingInvite = invite;
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    if (rawGet(KEYS.pin)) { updateUI(); openModal('lock-dlg'); } else startSession();
}

init();
