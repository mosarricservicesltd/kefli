// The page ports on the phone (mobile spec 5.4, 8.2): fetch, the parser WebView (for pages and for PDFs), and the
// browser engine for a page that turns the fetch away.
import { KefliParser } from '../../modules/kefli-parser/src';
import { renderAnswer, type PagePorts, type ParserResult } from './page';

export function phonePagePorts(): PagePorts {
  return {
    fetch,
    parse: (b, t, u) => KefliParser.parse(b, t, u) as Promise<ParserResult>,
    pdf: (b) => KefliParser.pdf(b),
    render: async (url) => renderAnswer(await KefliParser.render(url)),
  };
}
