import { verifyEvent } from 'nostr-tools/pure';
import { createHash } from 'node:crypto';
import { LocalSigner, buildDeletions, buildWrapDeletion, httpAuth, isDeleted, isXPost, itemAddress, linksInEmbed, pickXLink } from '../src';
import { nodeCrypto } from '../src/node';

const signer = () => new LocalSigner(nodeCrypto.randomBytes(32));

describe('X posts (C§4.3)', () => {
  test.each([
    ['https://x.com/jack/status/20', true],
    ['https://twitter.com/jack/status/20?s=46', true],
    ['https://mobile.twitter.com/jack/status/20', true],
    ['https://x.com/jack/status/20/photo/1', true],
    ['https://www.x.com/jack/status/20', true],
    ['https://x.com/jack', false],
    ['https://x.com/i/article/123', false],
    ['https://example.com/jack/status/20', false],
    ['https://x.com/jack/status/abc', false],
  ])('%s is a post: %s', (url, want) => expect(isXPost(url)).toBe(want));

  const embed = '<blockquote class="twitter-tweet"><p>Read this <a href="https://t.co/AAA">t.co/AAA</a> and <a href="https://t.co/BBB">x</a> <a href="https://twitter.com/hashtag/x?src=hash&amp;ref_src=twsrc">#x</a></p>&mdash; Jack (@jack) <a href="https://twitter.com/jack/status/20?ref_src=twsrc%5Etfw">March 21, 2006</a></blockquote>';

  test('links come out in order, entities decoded', () => {
    expect(linksInEmbed(embed)).toEqual(['https://t.co/AAA', 'https://t.co/BBB', 'https://twitter.com/hashtag/x?src=hash&ref_src=twsrc', 'https://twitter.com/jack/status/20?ref_src=twsrc%5Etfw']);
  });

  test('the first link leaving X is saved', async () => {
    const resolve = async (u: string) => ({ 'https://t.co/AAA': 'https://pic.x.com/abc', 'https://t.co/BBB': 'https://example.com/story' })[u]!;
    expect(await pickXLink(linksInEmbed(embed), resolve)).toEqual({ save: 'https://example.com/story' });
  });

  test('an X Article saves nothing, as does no outside link', async () => {
    expect(await pickXLink(['https://t.co/A'], async () => 'https://x.com/i/article/9')).toEqual({ nothing: 'article' });
    expect(await pickXLink(['https://twitter.com/jack'], async () => '')).toEqual({ nothing: 'no-link' });
  });

  test('a link that fails to resolve is passed over', async () => {
    const resolve = async (u: string) => {
      if (u.endsWith('A')) throw new Error('timeout');
      return 'https://example.com/b';
    };
    expect(await pickXLink(['https://t.co/A', 'https://t.co/B'], resolve)).toEqual({ save: 'https://example.com/b' });
  });
});

describe('deletions (C§4.1)', () => {
  test('batches of 50 with the k tag', async () => {
    const s = signer();
    const ds = Array.from({ length: 120 }, (_, i) => `shelf/item/${i.toString(16).padStart(64, '0')}`);
    const evs = await buildDeletions(s, ds, 10);
    expect(evs.map((e) => e.tags.filter((t) => t[0] === 'a').length)).toEqual([50, 50, 20]);
    for (const e of evs) {
      expect(verifyEvent(e)).toBe(true);
      expect(e.tags[e.tags.length - 1]).toEqual(['k', '30078']);
    }
    expect(isDeleted({ pubkey: s.pubkey(), created_at: 10 }, ds[119], evs)).toBe(true);
    expect(isDeleted({ pubkey: s.pubkey(), created_at: 11 }, ds[119], evs)).toBe(false); // a newer save survives
    expect(isDeleted({ pubkey: signer().pubkey(), created_at: 1 }, ds[0], evs)).toBe(false);
  });

  test('a wrap deletion', async () => {
    const e = await buildWrapDeletion(signer(), 'ab'.repeat(32), 1);
    expect(e.tags).toEqual([['e', 'ab'.repeat(32)], ['k', '1059']]);
    expect(itemAddress('pk', 'shelf/devices')).toBe('30078:pk:shelf/devices');
  });
});

describe('NIP-98 (C§6)', () => {
  const decode = (h: string) => JSON.parse(Buffer.from(h.replace(/^Nostr /, ''), 'base64').toString('utf8'));

  test('a POST carries u, method and the body’s hash', async () => {
    const s = signer();
    const body = JSON.stringify({ v: 1 });
    const ev = decode(await httpAuth(s, 'https://api.shelf.example/register', 'POST', body, nodeCrypto, 100));
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.kind).toBe(27235);
    expect(ev.created_at).toBe(100);
    expect(ev.tags).toEqual([['u', 'https://api.shelf.example/register'], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')]]);
  });

  test('a DELETE with no body hashes the empty string; a GET has no payload', async () => {
    const s = signer();
    const del = decode(await httpAuth(s, 'https://api.shelf.example/account', 'DELETE', null, nodeCrypto));
    expect(del.tags[2]).toEqual(['payload', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']);
    const get = decode(await httpAuth(s, 'https://api.shelf.example/pair-offers/ab', 'GET', null, nodeCrypto));
    expect(get.tags).toHaveLength(2);
  });
});
