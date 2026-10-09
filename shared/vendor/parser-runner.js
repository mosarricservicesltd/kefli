// The canonical parse (contract 4.2, mobile spec 9), shared by every platform that runs it in a browser
// engine: the phone's hidden WebView (kefli-parser), the extension, and the pinned headless Chromium that
// makes the page fixtures. Changing this file changes text_hash, so it regenerates the fixtures and bumps
// the contract.
//
//   kefliParse(bodyBase64, contentType, url, rules)  the page's bytes, as fetched, to a result
//   kefliMarkdown(contentHtml, url, rules)            Readability's content HTML (an extension save) to a result
//   kefliRun(jobId)                                   the kefli-parser entry: reads the job from, and writes the
//                                                     result to, the KefliHost object, so megabyte strings never
//                                                     pass through evaluateJavascript
//
// A result is {ok: true, title, byline, site, lang, hero, canonical, readerable, markdown}, with null for
// anything absent, or {ok: false, reason: 'not_readable' | 'error', message?}. The markdown is normalised
// (contract 4.2); the guard (fewer than 120 spoken words and not readerable) is applied by the caller, since
// the spoken projection runs on the platform's own engine.
(function () {
  'use strict';

  var DEFAULT_RULES = window.KEFLI_RULES;

  function absoluteHttp(href, base) {
    if (typeof href !== 'string' || href.trim() === '') return null;
    try {
      var u = new URL(href.trim(), base);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  // Decoding as a browser does it (HTML Standard, "determining the character encoding"): a byte order mark,
  // then the Content-Type charset, then a <meta> charset in the first 1,024 bytes, then UTF-8.
  function bomEncoding(b) {
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
    if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
    if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
    return null;
  }

  function headerCharset(contentType) {
    var m = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '');
    return m ? m[1] : null;
  }

  function metaCharset(b) {
    var head = '';
    for (var i = 0; i < Math.min(b.length, 1024); i++) head += String.fromCharCode(b[i]);
    var m = /<meta[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9_:.\-]+)/i.exec(head);
    return m ? m[1] : null;
  }

  function decoderFor(label) {
    try {
      return new TextDecoder(label);
    } catch (e) {
      return null;
    }
  }

  function decode(bytes, contentType) {
    var labels = [bomEncoding(bytes), headerCharset(contentType), metaCharset(bytes), 'utf-8'];
    for (var i = 0; i < labels.length; i++) {
      var d = labels[i] && decoderFor(labels[i]);
      // The Standard reads a UTF-16 label from <meta> as UTF-8, since the bytes were readable as ASCII.
      if (d && !(i === 2 && /^utf-16/.test(d.encoding))) return d.decode(bytes);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  function base64Bytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // The page's own <base> is made absolute against its address; without one, the address becomes the base,
  // so relative links resolve as they do on the live page.
  function documentFor(html, url) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var own = doc.querySelector('base[href]');
    if (own) {
      own.setAttribute('href', absoluteHttp(own.getAttribute('href'), url) || url);
    } else {
      var base = doc.createElement('base');
      base.setAttribute('href', url);
      (doc.head || doc.documentElement).insertBefore(base, (doc.head || doc.documentElement).firstChild);
    }
    return doc;
  }

  // contract 4.3: the first <link rel="canonical">, resolved against the page's address, http(s) only.
  function canonicalOf(doc, url) {
    var links = doc.querySelectorAll('link[rel]');
    for (var i = 0; i < links.length; i++) {
      var rels = links[i].getAttribute('rel').toLowerCase().split(/\s+/);
      if (rels.indexOf('canonical') !== -1) return absoluteHttp(links[i].getAttribute('href'), url);
    }
    return null;
  }

  function metaContent(doc, selector) {
    var m = doc.querySelector(selector);
    return m ? m.getAttribute('content') : null;
  }

  // og:image, else twitter:image (contract 4.3), resolved against the page's address, http(s) only.
  function heroOf(doc, url) {
    return absoluteHttp(metaContent(doc, 'meta[property="og:image"]'), url) || absoluteHttp(metaContent(doc, 'meta[name="twitter:image"]'), url);
  }

  // contract 4.2; packages/protocol's normaliseMarkdown is the same rule, and a test holds them together.
  function normaliseMarkdown(md) {
    return md
      .normalize('NFC')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(function (line) {
        return line.replace(/[ \t]+$/, '');
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n*$/, '\n');
  }

  function toMarkdown(html, rules) {
    if (rules.rules && rules.rules.length) throw new Error('turndown-rules.json has rules this runner does not apply');
    return normaliseMarkdown(new TurndownService(rules.options).turndown(html));
  }

  var orNull = function (s) {
    return typeof s === 'string' && s.trim() !== '' ? s : null;
  };

  function kefliParse(bodyBase64, contentType, url, rules) {
    var doc = documentFor(decode(base64Bytes(bodyBase64), contentType), url);
    // canonical, hero and readerable are read first, since parse() changes the document (contract 4.2).
    var canonical = canonicalOf(doc, url);
    var hero = heroOf(doc, url);
    var readerable = isProbablyReaderable(doc);
    var article = new Readability(doc).parse();
    if (!article || !article.content) return { ok: false, reason: 'not_readable', readerable: readerable, canonical: canonical, hero: hero };
    return {
      ok: true,
      title: orNull(article.title),
      byline: orNull(article.byline),
      site: orNull(article.siteName),
      lang: orNull(article.lang),
      hero: hero,
      canonical: canonical,
      readerable: readerable,
      markdown: toMarkdown(article.content, rules || DEFAULT_RULES),
    };
  }

  // Readability's content HTML for a page, prepared as kefliParse prepares it: what the extension sends with a
  // save (contract 4.4), and the fixtures' Readability output (contract 9).
  function kefliArticle(bodyBase64, contentType, url) {
    var doc = documentFor(decode(base64Bytes(bodyBase64), contentType), url);
    var article = new Readability(doc).parse();
    return article && article.content ? { ok: true, content: article.content } : { ok: false };
  }

  // An extension save: the extension has already read canonical, hero and the guard from the live page.
  function kefliMarkdown(contentHtml, url, rules) {
    var doc = documentFor(contentHtml, url);
    return {
      ok: true, title: null, byline: null, site: null, lang: null, hero: null, canonical: null, readerable: true,
      markdown: toMarkdown(doc.body ? doc.body.innerHTML : contentHtml, rules || DEFAULT_RULES),
    };
  }

  function kefliRun(jobId) {
    var result;
    try {
      var job = JSON.parse(window.KefliHost.input(jobId));
      result = job.kind === 'markdown' ? kefliMarkdown(job.html, job.url) : kefliParse(job.body, job.contentType, job.url);
    } catch (e) {
      result = { ok: false, reason: 'error', message: String(e && e.message ? e.message : e) };
    }
    window.KefliHost.output(jobId, JSON.stringify(result));
  }

  window.kefliParse = kefliParse;
  window.kefliMarkdown = kefliMarkdown;
  window.kefliArticle = kefliArticle;
  window.kefliRun = kefliRun;
  window.kefliNormaliseMarkdown = normaliseMarkdown;
})();
