// Backup space's words and figures (FD 117; prototype adv-space-*, adv-full, adv-daily, adv-toolarge, share-full,
// share-daily), character for character from the signed-off prototype.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MB, type Space } from '../src/data/account';
import { S, articles, mb, noticeText } from '../src/ui/strings';

const PROTOTYPE = readFileSync(join(__dirname, '../../../docs/design/mockups/prototype.html'), 'utf8');

/** The prototype's own mb(), the reference the app's must match. */
function prototypeMb(): (b: number) => string {
  const src = /const mb = (b => \{[^\n]*\});/.exec(PROTOTYPE)?.[1];
  if (!src) throw new Error('the prototype has no mb()');
  return new Function('MB', `return ${src}`)(MB) as (b: number) => string;
}

const figures = (used: number, quota = 50 * MB, level: 'room' | 'nearly' | 'full' = 'room'): Space => ({ kind: 'figures', used, quota, level });

describe('megabytes as Kefli’s server counts them (FD 117)', () => {
  test('one decimal, rounded down, so a library short of its quota never reads as the quota', () => {
    expect(mb(0)).toBe('0 MB');
    expect(mb(Math.round(3.25 * MB))).toBe('3.2 MB');
    expect(mb(Math.round(12.43 * MB))).toBe('12.4 MB');
    expect(mb(Math.round(49.96 * MB))).toBe('49.9 MB');
    expect(mb(50 * MB - 1)).toBe('49.9 MB');
    expect(mb(50 * MB)).toBe('50 MB');
    expect(mb(20 * MB)).toBe('20 MB');
    expect(mb(Math.round(120.34 * MB))).toBe('120.3 MB');
    expect(mb(MB / 10 - 1)).toBe('0 MB');
    expect(mb(MB / 10)).toBe('0.1 MB');
  });

  test('the same as the prototype’s mb() across the range, bytes of 1,048,576 to the megabyte', () => {
    const ref = prototypeMb();
    for (let b = 0; b <= 210 * MB; b += 104_729) expect(mb(b)).toBe(ref(b));
    for (const b of [1, MB - 1, MB, MB + 1, 46.14 * MB, 2 ** 40]) expect(mb(Math.round(b))).toBe(ref(Math.round(b)));
  });

  test('a figure below nothing reads as nothing', () => {
    expect(mb(-5)).toBe('0 MB');
  });

  test('the articles a quota holds, at 25 KB each, rounded to the hundred, as the prototype writes them', () => {
    for (const q of [50 * MB, 200 * MB, 75 * MB, 1000 * MB, 10 * MB]) {
      expect(articles(q)).toBe((Math.round(q / (25 * 1024) / 100) * 100).toLocaleString('en-GB'));
    }
    expect(articles(50 * MB)).toBe('2,000');
    expect(articles(1000 * MB)).toBe('41,000');
  });
});

describe('the Backup space row and its fine print', () => {
  test('its group and row, as drawn', () => {
    expect(S.adv.space).toBe('Backup space');
    expect(S.adv.server).toBe('Kefli’s server');
    expect(PROTOTYPE).toContain('<div class="gtitle">Backup space</div>');
    expect(PROTOTYPE).toContain(`<span class="yl">${S.adv.server}<small`);
  });

  test('its sub in every state (adv, adv-space-nearly, adv-full, adv-space-empty)', () => {
    expect(S.adv.spaceSub(figures(Math.round(12.43 * MB)))).toBe('12.4 MB of 50 MB');
    expect(S.adv.spaceSub(figures(Math.round(46.14 * MB), 50 * MB, 'nearly'))).toBe('46.1 MB of 50 MB · nearly full');
    expect(S.adv.spaceSub(figures(Math.round(49.96 * MB), 50 * MB, 'full'))).toBe('Full · 49.9 MB of 50 MB');
    expect(S.adv.spaceSub(figures(Math.round(120.3 * MB), 50 * MB, 'full'))).toBe('Full · 120.3 MB of 50 MB');
    expect(S.adv.spaceSub(figures(0))).toBe('0 MB of 50 MB');
  });

  test('with no figures held (adv-space-loading, adv-space-offline, adv-space-error), in the prototype’s words', () => {
    expect(S.adv.spaceSub({ kind: 'checking' })).toBe('Checking…');
    expect(S.adv.spaceSub({ kind: 'offline' })).toBe('Checks when you’re online');
    expect(S.adv.spaceSub({ kind: 'failed' })).toBe('Couldn’t check');
    for (const kind of ['checking', 'offline', 'failed'] as const) expect(PROTOTYPE).toContain(`'${S.adv.spaceSub({ kind })}'`);
  });

  test('the fine print in the library’s own figures, the defaults until the first answer', () => {
    expect(S.adv.spaceNote(50 * MB, 20 * MB)).toBe(
      'Kefli’s server keeps up to 50 MB of your saves’ text, about 2,000 articles, and takes up to 20 MB a day. Past that, a save’s text stays on this phone. Every save’s link is backed up whatever the space.',
    );
    expect(S.adv.spaceNote(200 * MB, 40 * MB)).toBe(
      'Kefli’s server keeps up to 200 MB of your saves’ text, about 8,200 articles, and takes up to 40 MB a day. Past that, a save’s text stays on this phone. Every save’s link is backed up whatever the space.',
    );
    expect(PROTOTYPE).toContain('of your saves’ text, about ${articles} articles, and takes up to ${mb(daily)} a day. Past that, a save’s text stays on this phone. Every save’s link is backed up whatever the space.');
  });
});

describe('the notice slot’s words (adv-full, adv-daily, adv-notbacked, adv-toolarge)', () => {
  test('room on the space', () => {
    expect(noticeText({ kind: 'full', n: 3 })).toBe('Your backup space is full, so the text of three saves is only on this phone. Kefli tries again each day, and deleting saves makes room.');
    expect(noticeText({ kind: 'full', n: 1 })).toBe('Your backup space is full, so the text of one save is only on this phone. Kefli tries again each day, and deleting saves makes room.');
    expect(noticeText({ kind: 'full', n: 12 })).toMatch(/the text of 12 saves is only/);
  });

  test('the day’s uploads used', () => {
    expect(noticeText({ kind: 'daily', n: 3 })).toBe('You’ve saved a lot today, so the text of three saves is only on this phone for now. Kefli tries again tomorrow.');
    expect(noticeText({ kind: 'daily', n: 1 })).toBe('You’ve saved a lot today, so the text of one save is only on this phone for now. Kefli tries again tomorrow.');
  });

  test('the saves Kefli is still trying to back up, as before', () => {
    expect(noticeText({ kind: 'trying', n: 2 })).toBe('Two saves aren’t backed up yet. Kefli keeps trying until a backup server accepts them.');
    expect(noticeText({ kind: 'trying', n: 1 })).toBe(S.adv.notBacked(1));
  });

  test('texts too long to back up', () => {
    expect(noticeText({ kind: 'toolarge', n: 1 })).toBe('The text of one save is too long to back up, so it’s only on this phone. Its link is backed up.');
    expect(noticeText({ kind: 'toolarge', n: 2 })).toBe('The text of two saves is too long to back up, so it’s only on this phone. Their links are backed up.');
  });

  test('each as the prototype words it', () => {
    for (const s of [
      'Your backup space is full, so the text of ${saves(room.n)} is only on this phone. Kefli tries again each day, and deleting saves makes room.',
      'You’ve saved a lot today, so the text of ${saves(room.n)} is only on this phone for now. Kefli tries again tomorrow.',
      'The text of ${saves(tl)} is too long to back up, so it’s only on this phone. ${tl === 1 ? \'Its link is\' : \'Their links are\'} backed up.',
    ]) expect(PROTOTYPE).toContain(s);
  });
});

describe('the Saved sheet’s lines (share-full, share-daily)', () => {
  test('as the prototype words them', () => {
    expect(S.share.fullSub).toBe('Private. Your backup space is full, so its text stays on this phone.');
    expect(S.share.dailySub).toBe('Private. You’ve saved a lot today, so its text stays on this phone for now.');
    for (const s of [S.share.fullSub, S.share.dailySub, S.share.savedSub]) expect(PROTOTYPE).toContain(`'${s}'`);
  });
});
