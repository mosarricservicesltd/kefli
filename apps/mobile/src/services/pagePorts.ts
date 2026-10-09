// The page ports on the phone (mobile spec 5.4, 8.2): fetch, the parser WebView, and the browser engine for a page
// that turns the fetch away.
import { KefliParser } from '../../modules/kefli-parser/src';
import type { PagePorts, ParserResult } from './page';

export function phonePagePorts(): PagePorts {
  return {
    fetch,
    parse: (b, t, u) => KefliParser.parse(b, t, u) as Promise<ParserResult>,
    render: async (url) => {
      const r = await KefliParser.render(url);
      return r.ok ? { url: r.url, html: r.html } : null;
    },
  };
}
