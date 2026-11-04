import { encodeCode, decodeCode, parseWire } from './protocol.js';

const PING_MS = 6000;
const DEAD_MS = 20000;
const GATHER_MS = 5000;

export function createLink(opts, h) {
    const role = opts.role;
    const selfId = opts.selfId;
    const getName = opts.getName || (() => '');
    const RTC = opts.RTC || globalThis.RTCPeerConnection;
    const iceServers = opts.iceServers || [];
    const randomSid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    let sid = opts.sid || (role === 'host' ? randomSid() : null);

    const conns = new Set();
    let everOpened = false;
    let closed = false;
    let timer = null;

    const openConns = () => Array.from(conns).filter((c) => c.open);

    function newConn() {
        const pc = new RTC({ iceServers });
        const c = { pc, dc: null, peerId: null, name: '', open: false, lastSeen: Date.now(), rx: 0, rxBad: 0, tx: 0 };
        conns.add(c);
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') drop(c);
        };
        return c;
    }

    function gathered(pc) {
        return new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            let t;
            const done = () => { pc.removeEventListener('icegatheringstatechange', onChange); clearTimeout(t); resolve(); };
            const onChange = () => { if (pc.iceGatheringState === 'complete') done(); };
            pc.addEventListener('icegatheringstatechange', onChange);
            t = setTimeout(done, GATHER_MS);
        });
    }

    function raw(c, obj) {
        if (!c.dc || c.dc.readyState !== 'open') return;
        try { c.dc.send(JSON.stringify(obj)); c.tx++; } catch (e) { /* canal en cours de fermeture */ }
    }

    function wire(c, dc) {
        c.dc = dc;
        const onOpen = () => {
            if (c.open || closed) return;
            c.open = true;
            c.lastSeen = Date.now();
            everOpened = true;
            startTimer();
            if (role === 'guest') {
                let tries = 0;
                const hello = () => raw(c, { t: 'hello', id: selfId, name: getName(), sid });
                hello();
                c.helloTimer = setInterval(() => {
                    if (c.peerId || !conns.has(c) || ++tries > 40) { clearInterval(c.helloTimer); return; }
                    hello();
                }, 700);
            }
        };
        dc.onopen = onOpen;
        dc.onmessage = (e) => {
            if (closed) return;
            c.lastSeen = Date.now();
            if (!c.open && dc.readyState === 'open') onOpen();
            c.rx++;
            const m = parseWire(e.data);
            if (m) handle(c, m); else c.rxBad++;
        };
        dc.onclose = () => drop(c);
        dc.onerror = () => {};
        if (dc.readyState === 'open') onOpen();
    }

    function rosterList() {
        const list = [{ id: selfId, name: getName() }];
        openConns().forEach((c) => { if (c.peerId) list.push({ id: c.peerId, name: c.name }); });
        return list;
    }
    function broadcastRoster() {
        const msg = { t: 'roster', peers: rosterList() };
        openConns().forEach((c) => { if (c.peerId) raw(c, msg); });
    }
    function forward(except, obj) {
        openConns().forEach((c) => { if (c !== except && c.peerId) raw(c, obj); });
    }

    function handle(c, m) {
        switch (m.t) {
            case 'hello': {
                if (role !== 'host' || m.id === selfId) return;
                if (c.peerId === m.id) { raw(c, { t: 'welcome', sid, hostId: selfId, hostName: getName() }); return; }
                Array.from(conns).forEach((o) => { if (o !== c && o.peerId === m.id) drop(o); });
                c.peerId = m.id;
                c.name = m.name;
                const resumed = !!(m.sid && m.sid === sid);
                raw(c, { t: 'welcome', sid, hostId: selfId, hostName: getName() });
                h.onJoin({ id: m.id, name: m.name, resumed });
                broadcastRoster();
                if (resumed) raw(c, { t: 'sync', msgs: h.getHistory() });
                break;
            }
            case 'welcome': {
                if (role !== 'guest' || c.peerId) return;
                const resumed = !!(sid && sid === m.sid);
                sid = m.sid;
                c.peerId = m.hostId;
                c.name = m.hostName;
                h.onJoin({ id: m.hostId, name: m.hostName, sid, resumed });
                if (resumed) raw(c, { t: 'sync', msgs: h.getHistory() });
                break;
            }
            case 'roster':
                if (role === 'guest' && c.peerId) h.onRoster(m.peers);
                break;
            case 'msg': {
                if (!c.peerId) return;
                const msg = role === 'host' ? Object.assign({}, m, { from: c.peerId }) : m;
                const isNew = h.onMessage(msg);
                if (role === 'host' && isNew) forward(c, { t: 'msg', id: msg.id, from: msg.from, text: msg.text, ts: msg.ts, vocal: msg.vocal });
                break;
            }
            case 'del': {
                if (!c.peerId) return;
                const applied = h.onDelete(m.id, role === 'host' ? c.peerId : null);
                if (role === 'host' && applied) forward(c, { t: 'del', id: m.id });
                break;
            }
            case 'sync':
                if (c.peerId) h.onSync(m.msgs);
                break;
            case 'bye':
                if (role === 'host') drop(c);
                else if (c.peerId) h.onEnded();
                break;
            default: break;
        }
    }

    function drop(c) {
        if (!conns.has(c)) return;
        conns.delete(c);
        clearInterval(c.helloTimer);
        const wasOpen = c.open;
        c.open = false;
        try { if (c.dc) c.dc.close(); } catch (e) { /* ignore */ }
        try { c.pc.close(); } catch (e) { /* ignore */ }
        if (closed) return;
        if (c.peerId) {
            h.onLeave(c.peerId);
            if (role === 'host') broadcastRoster();
        }
        if (wasOpen && everOpened && openConns().length === 0) h.onLost();
    }

    function startTimer() {
        if (timer || closed) return;
        timer = setInterval(() => {
            const now = Date.now();
            openConns().forEach((c) => {
                if (now - c.lastSeen > DEAD_MS) { drop(c); return; }
                raw(c, { t: 'ping' });
            });
        }, PING_MS);
    }

    function closeAll() {
        clearInterval(timer);
        timer = null;
        Array.from(conns).forEach((c) => {
            conns.delete(c);
            clearInterval(c.helloTimer);
            try { if (c.dc) c.dc.close(); } catch (e) { /* ignore */ }
            try { c.pc.close(); } catch (e) { /* ignore */ }
        });
    }

    async function hostCreateOffer() {
        const c = newConn();
        wire(c, c.pc.createDataChannel('sm'));
        await c.pc.setLocalDescription(await c.pc.createOffer());
        await gathered(c.pc);
        return { handle: c, code: await encodeCode('o', c.pc.localDescription.sdp) };
    }

    async function hostAcceptAnswer(handle, code) {
        const { kind, sdp } = await decodeCode(code);
        if (kind !== 'a') throw new Error('wrong-kind');
        await handle.pc.setRemoteDescription({ type: 'answer', sdp });
    }

    async function guestJoin(code) {
        const { kind, sdp } = await decodeCode(code);
        if (kind !== 'o') throw new Error('wrong-kind');
        const c = newConn();
        c.pc.ondatachannel = (e) => wire(c, e.channel);
        await c.pc.setRemoteDescription({ type: 'offer', sdp });
        await c.pc.setLocalDescription(await c.pc.createAnswer());
        await gathered(c.pc);
        return { handle: c, code: await encodeCode('a', c.pc.localDescription.sdp) };
    }

    function cancelPending() {
        Array.from(conns).forEach((c) => {
            if (!c.open) {
                conns.delete(c);
                try { c.pc.close(); } catch (e) { /* ignore */ }
            }
        });
    }

    function send(obj) { openConns().forEach((c) => { if (c.peerId) raw(c, obj); }); }

    function end() {
        send({ t: 'bye' });
        closed = true;
        clearInterval(timer);
        setTimeout(closeAll, 300);
    }
    function close() { closed = true; closeAll(); }

    return {
        role, hostCreateOffer, hostAcceptAnswer, guestJoin, cancelPending, send, end, close,
        isOpen: () => openConns().length > 0,
        debug: () => Array.from(conns).map((c) => ({ conn: c.pc.connectionState, ice: c.pc.iceConnectionState, gather: c.pc.iceGatheringState, dc: c.dc ? c.dc.readyState : null, open: c.open, peer: c.peerId, rx: c.rx, rxBad: c.rxBad, tx: c.tx })),
        peerCount: () => openConns().filter((c) => c.peerId).length
    };
}
