// Entry point for the canonical parse, shared by every platform that runs JS.
// Turndown options are provisional until shared/turndown-rules.json is written
// with the fixtures (contract section 3).
window.shelfParse = function (html, url) {
  var started = Date.now();
  function reply(msg) {
    msg.ms = Date.now() - started;
    var text = JSON.stringify(msg);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(text);
    return text;
  }
  try {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var base = doc.createElement('base');
    base.href = url;
    doc.head.insertBefore(base, doc.head.firstChild);

    var readerable = isProbablyReaderable(doc);
    var article = new Readability(doc).parse();
    if (!article || !article.content) {
      return reply({ ok: false, error: 'readability_empty', readerable: readerable });
    }

    var td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '_',
    });
    var markdown = td.turndown(article.content);
    var words = markdown.split(/\s+/).filter(Boolean).length;

    return reply({
      ok: true,
      readerable: readerable,
      title: article.title,
      byline: article.byline,
      siteName: article.siteName,
      lang: article.lang,
      excerpt: article.excerpt,
      markdown: markdown,
      words: words,
      htmlBytes: html.length,
    });
  } catch (e) {
    return reply({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};
