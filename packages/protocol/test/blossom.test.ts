import { verifyEvent } from 'nostr-tools/pure';
import { LocalSigner, blossomAuth, deleteBlob, mirrorBlob, uploadBlob } from '../src';
import { nodeCrypto } from '../src/node';

const SHA = 'ab'.repeat(32);
const signer = () => new LocalSigner(nodeCrypto.randomBytes(32));
const decode = (h: string) => JSON.parse(Buffer.from(h.replace(/^Nostr /, ''), 'base64').toString('utf8'));

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Blossom (contract 4.2, 5)', () => {
  test('authorisation: kind 24242 with t, x and a one-hour expiration', async () => {
    const ev = decode(await blossomAuth(signer(), 'upload', SHA, 1000));
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.kind).toBe(24242);
    expect(ev.tags).toEqual([['t', 'upload'], ['x', SHA], ['expiration', '4600']]);
    await expect(blossomAuth(signer(), 'upload', 'nope')).rejects.toThrow('sha256');
  });

  test('upload puts the bytes with their hash and checks the descriptor', async () => {
    const { f, calls } = fakeFetch(200, { sha256: SHA, url: `http://b/${SHA}` });
    const r = await uploadBlob('http://b/', new Uint8Array([1, 2]), SHA, signer(), f);
    expect(r).toEqual({ ok: true, url: `http://b/${SHA}` });
    expect(calls[0].url).toBe('http://b/upload');
    expect(calls[0].init.method).toBe('PUT');
    expect((calls[0].init.headers as Record<string, string>)['X-SHA-256']).toBe(SHA);
    const other = fakeFetch(200, { sha256: 'cd'.repeat(32) });
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), other.f)).toMatchObject({ ok: false, status: 502 });
  });

  test('a 413 is permanent; 401 and 429 are not', async () => {
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), fakeFetch(413, 'full', { 'x-reason': 'quota' }).f)).toEqual({ ok: false, status: 413, permanent: true, reason: 'quota' });
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), fakeFetch(401, 'no').f)).toMatchObject({ permanent: false });
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), fakeFetch(429, 'slow').f)).toMatchObject({ permanent: false });
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), fakeFetch(503, 'down').f)).toMatchObject({ permanent: false });
  });

  test('mirror asks the mirror to fetch the url', async () => {
    const { f, calls } = fakeFetch(200, { sha256: SHA });
    const r = await mirrorBlob('http://m', `http://b/${SHA}`, SHA, signer(), f);
    expect(r).toEqual({ ok: true, url: `http://m/${SHA}` });
    expect(calls[0].url).toBe('http://m/mirror');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ url: `http://b/${SHA}` });
    expect(await mirrorBlob('http://m', 'x', SHA, signer(), fakeFetch(400, 'refused').f)).toMatchObject({ ok: false, permanent: true });
    expect(await mirrorBlob('http://m', 'x', SHA, signer(), fakeFetch(200, { sha256: 'cd'.repeat(32) }).f)).toMatchObject({ ok: false, status: 502 });
  });

  test('delete: done on success or 404', async () => {
    const del = fakeFetch(200, '');
    expect(await deleteBlob('http://b', SHA, signer(), del.f)).toMatchObject({ ok: true });
    expect(decode((del.calls[0].init.headers as Record<string, string>).Authorization).tags[0]).toEqual(['t', 'delete']);
    expect(await deleteBlob('http://b', SHA, signer(), fakeFetch(404, '').f)).toMatchObject({ ok: true });
    expect(await deleteBlob('http://b', SHA, signer(), fakeFetch(500, 'x').f)).toMatchObject({ ok: false, permanent: false });
  });
});
