// The toast’s and the popup’s marks on a page served as XHTML, where the toast’s markup is parsed as XML: a second
// stroke-width on an icon made the Saved toast throw and stay at Saving…, and in HTML drew the marks at the wrong weight.
import { icon, MARKS } from '../src/icons';

describe('the toast’s marks, in a page served as XHTML', () => {
  /** An SVG's start tag's attribute names, in order. */
  const names = (svg: string) => [...svg.match(/^<svg([^>]*)>/)![1].matchAll(/\s([a-z-]+)=/g)].map((m) => m[1]);
  test('no attribute is given twice, which the XML parser refuses', () => {
    for (const svg of [...Object.values(MARKS), icon('check', 20, 2.5), icon('x', 18)]) expect(new Set(names(svg)).size).toBe(names(svg).length);
  });
  test('the marks draw with the mockup’s heavier strokes', () => {
    expect([MARKS.ok, MARKS.bad, MARKS.off].map((s) => s.match(/stroke-width="([\d.]+)"/)![1])).toEqual(['3', '3', '2.25']);
  });
});
