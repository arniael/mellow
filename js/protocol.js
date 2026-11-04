export const PREFIX = 'SM1';
const MAX_SDP = 20000;
const MAX_TEXT = 4000;
const MAX_NAME = 40;
const MAX_WIRE = 400000;
const MAX_SYNC = 500;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function b64uEncode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function pump(bytes, transform, maxOut) {
    const writer = transform.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    const reader = transform.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxOut) { reader.cancel().catch(() => {}); throw new Error('too-big'); }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
}
export const deflate = (text) => pump(new TextEncoder().encode(text), new CompressionStream('deflate-raw'), MAX_SDP * 2);
export const inflate = async (bytes) => new TextDecoder().decode(await pump(bytes, new DecompressionStream('deflate-raw'), MAX_SDP));

export async function encodeCode(kind, sdp) {
    return PREFIX + kind + b64uEncode(await deflate(sdp));
}

export async function decodeCode(code) {
    const c = String(code || '').replace(/\s+/g, '');
    if (!c.startsWith(PREFIX) || c.length < 8) throw new Error('bad-code');
    const kind = c[PREFIX.length];
    if (kind !== 'o' && kind !== 'a') throw new Error('bad-code');
    let sdp;
    try { sdp = await inflate(b64uDecode(c.slice(PREFIX.length + 1))); } catch (e) { throw new Error('bad-code'); }
    if (!sdp.startsWith('v=0') || sdp.length > MAX_SDP) throw new Error('bad-code');
    return { kind, sdp };
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const id = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const ts = (v) => (Number.isFinite(v) && v > 0 && v < 4e12 ? v : Date.now());

function cleanMsg(m) {
    if (!m || typeof m !== 'object') return null;
    const mid = id(m.id), from = id(m.from);
    if (!mid || !from) return null;
    const vocal = m.vocal === true;
    const text = vocal ? '' : str(m.text, MAX_TEXT);
    if (!vocal && !text) return null;
    return { id: mid, from, text, ts: ts(m.ts), vocal };
}

export function parseWire(data) {
    if (typeof data !== 'string' || data.length > MAX_WIRE) return null;
    let o;
    try { o = JSON.parse(data); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    switch (o.t) {
        case 'hello': {
            const pid = id(o.id);
            if (!pid) return null;
            return { t: 'hello', id: pid, name: str(o.name, MAX_NAME), sid: id(o.sid) };
        }
        case 'welcome': {
            const hid = id(o.hostId), sid = id(o.sid);
            if (!hid || !sid) return null;
            return { t: 'welcome', sid, hostId: hid, hostName: str(o.hostName, MAX_NAME) };
        }
        case 'roster': {
            if (!Array.isArray(o.peers)) return null;
            const peers = o.peers.slice(0, 20).map((p) => (p && id(p.id) ? { id: p.id, name: str(p.name, MAX_NAME) } : null)).filter(Boolean);
            return { t: 'roster', peers };
        }
        case 'msg': {
            const m = cleanMsg(o);
            return m ? Object.assign({ t: 'msg' }, m) : null;
        }
        case 'del': {
            const did = id(o.id);
            return did ? { t: 'del', id: did } : null;
        }
        case 'sync': {
            if (!Array.isArray(o.msgs)) return null;
            return { t: 'sync', msgs: o.msgs.slice(0, MAX_SYNC).map(cleanMsg).filter(Boolean) };
        }
        case 'ping': return { t: 'ping' };
        case 'bye': return { t: 'bye' };
        default: return null;
    }
}
