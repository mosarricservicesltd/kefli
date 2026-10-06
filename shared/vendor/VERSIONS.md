# Vendored parser

The canonical article pipeline (contract section 3). The same files run in the extension and in the phone's hidden WebView, so `text_hash` matches across platforms. Bumping either library regenerates the fixture hashes and bumps the contract version.

| Library | Version | Source | File | sha256 |
|---|---|---|---|---|
| @mozilla/readability | 0.6.0 | npm tarball | `readability-0.6.0/Readability.js` | `34dcab3d0832d0019f02990eed6b6124e029e8c32b9f0c6f2550544ff8dff174` |
| @mozilla/readability | 0.6.0 | npm tarball | `readability-0.6.0/Readability-readerable.js` | `a98d28805804c1986ceed470678a3f409f150ee7f1d227f8c8239c005d21de65` |
| turndown | 7.2.4 | npm tarball (`lib/turndown.browser.umd.js`) | `turndown-7.2.4/turndown.browser.umd.js` | `cdf933e0a2085df3c64d6c763331f04345f6c3b25746216e8f1426c9c5253045` |
| Turndown rules | v1 | written for contract 1.3 (section 4.2): the options `parser-runner.js` uses and no added rules | `../turndown-rules.json` | `52b606a01ca6c26c82bf3913769c43ccf64908d771930653cec7c8b235f638d3` |

Licences: Readability is Apache-2.0 (`LICENSE.md`), Turndown is MIT (`LICENSE`).

Files are copied byte-for-byte from the published tarballs. Do not edit them; wrap them instead.
