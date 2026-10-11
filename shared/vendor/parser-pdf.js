// The phone's PDF read (contract 4.2, PDFs; flow decision 103), added to the parser bundle for the kefli-parser
// WebView only, so the extension never carries a module loader:
//
//   kefliPdf(bodyBase64)  a PDF's text runs (shared/vendor/pdf-runner.mjs), or why there are none. pdf.js comes from
//                         KefliHost.asset on the first PDF, so a page parse never pays for it, and is kept for the
//                         WebView's life; packages/protocol's pdfMarkdown lays the runs out on Hermes.
(function () {
  'use strict';

  // pdf.js is ES modules, so each comes in as a blob URL; the worker's module, set as pdfjsWorker, lets pdf.js
  // parse on this thread.
  var modules = null;

  function fromAsset(name) {
    var url = URL.createObjectURL(new Blob([window.KefliHost.asset(name)], { type: 'text/javascript' }));
    return import(url);
  }

  function load() {
    if (!modules) {
      modules = fromAsset('pdf.worker.min.mjs').then(function (worker) {
        window.pdfjsWorker = worker;
        return Promise.all([fromAsset('pdf.min.mjs'), fromAsset('pdf-runner.mjs')]);
      });
      modules.catch(function () {
        modules = null;
      });
    }
    return modules;
  }

  window.kefliPdf = function (bodyBase64) {
    return load().then(function (m) {
      return m[1].pdfRuns(m[0], window.kefliBase64Bytes(bodyBase64));
    });
  };
})();
