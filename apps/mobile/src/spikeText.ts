// Text for the Android test build's speech tests, written for it. PARAGRAPH is short, for word positions;
// LONG_TEXT runs well past five minutes at the default rate, in parts under Android's 4,000-character limit.

export const PARAGRAPH =
  'A saved article waits quietly until you have time for it. When you open it on the train, the words are already on your phone, clean and easy to read, and the phone can read them aloud while you look out of the window.';

const PARTS = [
  'Most of what we mean to read arrives at the wrong moment. A friend sends a long essay during a meeting, a newsletter lands while dinner is cooking, and a thread points to a report that deserves an hour nobody has spare. A read-it-later app exists for exactly this gap between finding something and being ready for it. You keep the thing now and give it your attention later, when the moment suits you.',
  'The oldest version of the idea is a pile of magazines beside a chair. It worked because the pile was yours, it stayed where you left it, and nobody rearranged it to keep you busy. The pile never sent a notification. It simply waited, and when you sat down with a cup of tea, the next thing to read was right there, in the order you had chosen.',
  'Listening changes the shape of the day. A long article that would need twenty quiet minutes at a desk fits neatly into a walk to the shops or a slow train home. The voice does not need to be perfect; it needs to be steady, to keep its place, and to carry on when the phone goes back into a pocket with the screen turned off.',
  'Keeping a library for years asks for a different kind of care. Services close, companies change their minds, and formats fall out of use. A library that lives under your own key, copied to more than one place, has a better chance of still being there in ten years, with every article where you left it and every half-read page marked where you stopped.',
  'There is a pleasure in finishing things. Archiving an article you have read, or listened to all the way through, is a small and satisfying act. The list gets shorter, the shelf gets tidier, and the next piece waiting for you is one you chose on purpose, on a better day, because you thought it would be worth your time.',
];

// Four rounds of the five parts, numbered so the log shows how far the voice got: about eleven minutes in all.
export const LONG_TEXT = Array.from({ length: 4 }, (_, round) => PARTS.map((p, k) => `Part ${round * PARTS.length + k + 1}. ${p}`)).flat();
