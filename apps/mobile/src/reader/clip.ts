// A page's title, site and byline as read from it (mobile spec 5.4) have no length of their own: a page can give its
// title a megabyte, which the Reader would lay out whole as its heading and the voice would hand the media session,
// whose metadata crosses to the system in one Binder transaction of at most 1 MB. What they show is clipped.

/** The Reader's heading and the lines above and under it, at most. No real title comes near. */
export const TITLE_CHARS = 1_000;
/** What the voice's media session shows, at most: a notification and a lock screen show a line or two. */
export const SESSION_CHARS = 300;

/** Text cut to at most max characters, never inside a surrogate pair, with an ellipsis where it was cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 2] ?? '') ? max - 2 : max - 1;
  return `${text.slice(0, end)}…`;
}
