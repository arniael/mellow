// Tests du protocole (Node 22+) : node tests/protocol.test.mjs
import assert from 'node:assert/strict';
import { encodeCode, decodeCode, parseWire, b64uEncode, b64uDecode } from '../js/protocol.js';

const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=ice-ufrag:abcd\r\n' + 'a=candidate:1 1 udp 2113937151 192.168.1.20 54400 typ host\r\n'.repeat(5);

// codes
for (const kind of ['o', 'a']) {
    const code = await encodeCode(kind, sdp);
    assert.ok(code.startsWith('SM1' + kind));
    const back = await decodeCode('  ' + code.slice(0, 20) + '\n' + code.slice(20) + ' ');
    assert.equal(back.kind, kind);
    assert.equal(back.sdp, sdp);
}
for (const bad of ['', 'hello', 'SM1x1234', 'SM1o!!!!', 'SM1oAAAAAAAA', 'SM2oAAAA', null, undefined]) {
    await assert.rejects(() => decodeCode(bad), /bad-code/, 'doit rejeter ' + bad);
}
assert.deepEqual(Array.from(b64uDecode(b64uEncode(new Uint8Array([0, 250, 255, 3])))), [0, 250, 255, 3]);

// messages hostiles
const ok = parseWire(JSON.stringify({ t: 'msg', id: 'a1', from: 'u1', text: 'salut', ts: 1700000000000, vocal: false }));
assert.equal(ok.text, 'salut');
assert.equal(parseWire('not json'), null);
assert.equal(parseWire(JSON.stringify({ t: 'msg', id: '<script>', from: 'u1', text: 'x' })), null);
assert.equal(parseWire(JSON.stringify({ t: 'msg', id: 'a', from: 'u1', text: '' })), null);
assert.equal(parseWire(JSON.stringify({ t: 'inconnu' })), null);
assert.equal(parseWire('x'.repeat(500000)), null);
assert.equal(parseWire(JSON.stringify({ t: 'msg', id: 'a', from: 'u', text: 'y'.repeat(9000) })).text.length, 4000);
assert.equal(parseWire(JSON.stringify({ t: 'sync', msgs: Array(2000).fill({ id: 'a', from: 'u', text: 'z' }) })).msgs.length, 500);
assert.deepEqual(parseWire(JSON.stringify({ t: 'msg', id: 'a', from: 'u', vocal: true })).vocal, true);

console.log('protocol: OK');
