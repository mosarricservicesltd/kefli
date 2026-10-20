// A sheet under a second share's sheet (mobile spec 8.5). Seen on the Pixel on 20 October 2026: two shares from adb
// fifteen seconds apart, both saved, but the first sheet closed the moment the second rose. The sheet closed on
// React Native's AppState, which is the whole app's: the second sheet's rise paused the first activity, AppState went
// to background, and the first sheet read that as leaving the screen. ShareActivity now says itself which sheet is in
// front and when one has left. Node can't run the system: these check the Kotlin's three callbacks as written, then
// play Android's order of callbacks over them, as secondShare.test.ts plays its launch rule.
import { kotlinSource, member, statements } from './kotlin';

const activity = kotlinSource('kefli-share', 'share', 'ShareActivity.kt');
const body = (name: string) => statements(member(activity, name).split('\n').slice(1));

type Event = { top: string | null } | { left: string };

/** ShareActivity's callbacks, as the Kotlin below reads, over one process's sheets. */
function phone() {
  let top: string | null = null;
  const events: Event[] = [];
  return {
    events,
    onResume: (spool: string) => {
      top = spool;
      events.push({ top });
    },
    onPause: (spool: string) => {
      if (top === spool) {
        top = null;
        events.push({ top: null });
      }
    },
    onStop: (spool: string) => {
      if (top === null) events.push({ left: spool });
    },
  };
}

/** What a sheet makes of the events: closed when it has left, and held while another sheet is in front. */
function sheet(spool: string, events: Event[]) {
  let covered = false;
  let closed = false;
  for (const e of events) {
    if ('left' in e && e.left === spool) closed = true;
    if ('top' in e) covered = e.top !== null && e.top !== spool;
  }
  return { covered, closed };
}

describe('a sheet under a second share (8.5)', () => {
  test('the Kotlin: in front on resume, out of front on pause, and left only on a stop with no sheet in front', () => {
    expect(body('onResume')).toEqual(['super.onResume()', 'top = spoolId', 'emit(Event.Top(top))']);
    expect(body('onPause')).toEqual(['if (top == spoolId) {', 'top = null', 'emit(Event.Top(null))', 'super.onPause()']);
    expect(body('onStop')).toEqual(['super.onStop()', 'val id = spoolId', 'if (top == null && id != null) emit(Event.Left(id))']);
  });

  test('a second share rises over the first, which stays up with its countdown held', () => {
    const p = phone();
    p.onResume('a');
    // Android pauses the sheet in front before it starts the next; the first sheet is translucent, so the second,
    // translucent too, leaves it paused and visible beneath, never stopped
    p.onPause('a');
    p.onResume('b');
    expect(sheet('a', p.events)).toEqual({ covered: true, closed: false });
    expect(sheet('b', p.events)).toEqual({ covered: false, closed: false });
  });

  test('once the second closes, the first is in front again and its countdown runs on', () => {
    const p = phone();
    p.onResume('a');
    p.onPause('a');
    p.onResume('b');
    p.onPause('b'); // b finishes
    p.onResume('a');
    p.onStop('b');
    expect(sheet('a', p.events)).toEqual({ covered: false, closed: false });
  });

  test('locked with both up, both have left and close, as one sheet does when locked', () => {
    const p = phone();
    p.onResume('a');
    p.onPause('a');
    p.onResume('b');
    p.onPause('b');
    p.onStop('b');
    p.onStop('a');
    expect(sheet('a', p.events).closed).toBe(true);
    expect(sheet('b', p.events).closed).toBe(true);
  });

  test('one sheet locked, or with another app on top, has left, as before', () => {
    const p = phone();
    p.onResume('a');
    p.onPause('a');
    p.onStop('a');
    expect(sheet('a', p.events).closed).toBe(true);
  });

  test("Read now from the second opens the Reader over the first, which is no longer covered and runs out its time", () => {
    const p = phone();
    p.onResume('a');
    p.onPause('a');
    p.onResume('b');
    p.onPause('b'); // b finishes; MainActivity starts in a task of its own, over a's
    p.onStop('b');
    p.onStop('a');
    expect(sheet('a', p.events)).toEqual({ covered: false, closed: true });
  });
});
