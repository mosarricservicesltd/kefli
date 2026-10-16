// The extension's own pages (options, the browser-page popup, the toast) built element by element: every value lands as
// text or as an attribute and none is parsed as markup, which a reader can see and the stores' linters find nothing to
// flag. Attributes go on in the order given, as the markup strings they replace had them.

/** A child: an element, text, a list of either, or nothing (false, null, undefined or ''), which is left out. */
export type Child = Node | string | false | null | undefined | Child[];
/** Attribute values: text, true for a bare attribute (as `open`), or false, null or undefined for none. */
export type Attrs = Record<string, string | true | false | null | undefined>;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Children added to the end of a parent, those that are nothing left out (the platform's append would write "null"). */
export function add(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === '' || c === false || c == null) continue;
    if (Array.isArray(c)) add(parent, ...c);
    else parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

/** An element with its attributes and children. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    e.setAttribute(k, v === true ? '' : v);
  }
  add(e, ...children);
  return e;
}

/** A stylesheet, its text as given. */
export function style(css: string): HTMLStyleElement {
  const s = document.createElement('style');
  s.textContent = css;
  return s;
}

/**
 * An SVG our own code drew (an icon, a mark, a cover, the pairing QR) as an element: parsed as XML, as a page served as
 * XHTML parses the toast's markup, then brought into this document. One that isn't well-formed throws, as it would there.
 * Where the markup leaves the namespace out it is declared for the parse and the declaration taken off again, so the
 * element is as the HTML parser made it from the same string.
 */
export function svg(markup: string): SVGSVGElement {
  const declared = /<svg[^>]*\sxmlns=/.test(markup);
  const doc = new DOMParser().parseFromString(declared ? markup : markup.replace(/<svg(?=[\s>])/, `<svg xmlns="${SVG_NS}"`), 'image/svg+xml');
  const root = doc.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) throw new Error('not well-formed SVG');
  const node = document.importNode(root, true) as unknown as SVGSVGElement;
  if (!declared) node.removeAttribute('xmlns');
  return node;
}
