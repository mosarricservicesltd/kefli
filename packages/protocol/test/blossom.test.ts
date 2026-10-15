import { verifyEvent } from 'nostr-tools/pure';
import { LocalSigner, blossomAuth, deleteBlob, mirrorBlob, readFigures, uploadBlob } from '../src';
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

  test("the operator's refusals for room carry their reason and the library's figures (contract 5, v1.12)", async () => {
    const figures = { quota: 52_428_800, used: 52_400_000, daily: 20_971_520, today: 1_000 };
    const quota = fakeFetch(413, { v: 1, error: 'quota', ...figures }, { 'x-reason': 'quota' });
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), quota.f)).toEqual({ ok: false, status: 413, permanent: true, reason: 'quota', figures });
    // the body's error stands in for a missing X-Reason, and the figures come whichever names the reason
    const daily = fakeFetch(413, { v: 1, error: 'daily', ...figures, today: 20_971_000 });
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), daily.f)).toMatchObject({ reason: 'daily', figures: { today: 20_971_000 } });
    // too_large carries no figures; nor does a body whose figures aren't whole numbers of bytes
    const big = fakeFetch(413, { v: 1, error: 'too_large' }, { 'x-reason': 'too_large' });
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), big.f)).toEqual({ ok: false, status: 413, permanent: true, reason: 'too_large' });
    const odd = fakeFetch(413, { v: 1, error: 'quota', ...figures, used: -1 });
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), odd.f)).not.toHaveProperty('figures');
    // a proxy's 413 page, with no reason of the operator's, keeps its text as before
    const proxy = fakeFetch(413, '<html>Request Entity Too Large</html>');
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), proxy.f)).toEqual({ ok: false, status: 413, permanent: true, reason: '<html>Request Entity Too Large</html>' });
    // a disk below its floor is a server error, not a refusal
    expect(await uploadBlob('http://b', new Uint8Array(), SHA, signer(), fakeFetch(507, { v: 1, error: 'storage' }).f)).toMatchObject({ status: 507, permanent: false, reason: 'storage' });
  });

  test('figures are read only when all four are there', () => {
    expect(readFigures({ quota: 1, used: 0, daily: 2, today: 0 })).toEqual({ quota: 1, used: 0, daily: 2, today: 0 });
    for (const bad of [null, 'x', [], { quota: 1, used: 0, daily: 2 }, { quota: 1.5, used: 0, daily: 2, today: 0 }, { quota: '1', used: 0, daily: 2, today: 0 }]) {
      expect(readFigures(bad)).toBeNull();
    }
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

  test("a server's address loses its trailing slashes in linear time, however many it holds before them", async () => {
    // 40,000 slashes and a letter: the pattern that took them off was tried from each slash, and took 6 s a call
    const server = `http://b${'/'.repeat(40_000)}x`;
    const up = fakeFetch(200, { sha256: SHA });
    const mirror = fakeFetch(200, { sha256: SHA });
    const del = fakeFetch(200, '');
    const key = signer();
    await blossomAuth(key, 'upload', SHA); // the first signature's set-up is no part of the time
    const t = Date.now();
    expect(await uploadBlob(`${server}///`, new Uint8Array(), SHA, key, up.f)).toEqual({ ok: true, url: `${server}/${SHA}` });
    expect(await mirrorBlob(`${server}/`, `http://b/${SHA}`, SHA, key, mirror.f)).toEqual({ ok: true, url: `${server}/${SHA}` });
    expect(await deleteBlob(server, SHA, key, del.f)).toEqual({ ok: true, url: `${server}/${SHA}` });
    expect(Date.now() - t).toBeLessThan(3_000);
    expect([up.calls[0].url, mirror.calls[0].url, del.calls[0].url]).toEqual([`${server}/upload`, `${server}/mirror`, `${server}/${SHA}`]);
  });

  test('delete: done on success or 404', async () => {
    const del = fakeFetch(200, '');
    expect(await deleteBlob('http://b', SHA, signer(), del.f)).toMatchObject({ ok: true });
    expect(decode((del.calls[0].init.headers as Record<string, string>).Authorization).tags[0]).toEqual(['t', 'delete']);
    expect(await deleteBlob('http://b', SHA, signer(), fakeFetch(404, '').f)).toMatchObject({ ok: true });
    expect(await deleteBlob('http://b', SHA, signer(), fakeFetch(500, 'x').f)).toMatchObject({ ok: false, permanent: false });
  });
});
