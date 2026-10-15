// app.json plus what depends on the build: KEFLI_VARIANT=local points at server/dev's stack and allows cleartext
// to localhost; any other build needs KEFLI_DEFAULTS_URL (https) and allows no cleartext.
//   KEFLI_VARIANT=local npx expo prebuild   (the local stack)
//   KEFLI_DEFAULTS_URL=https://api.<domain>/defaults.json npx expo prebuild
// Every build bakes in a copy of defaults.json (contract 3.1, F1), which the phone uses when it has never fetched
// one and the operator can't be reached: server/staging/defaults.json for the local stack, otherwise
// defaults.release.json, or the file KEFLI_DEFAULTS_FILE names. It must name the same API as KEFLI_DEFAULTS_URL.
const fs = require('fs');
const path = require('path');

function bakedDefaults(file, defaultsUrl) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const urls = (xs) => Array.isArray(xs) && xs.every((x) => typeof x === 'string' && x.length > 0);
  const ok = d && d.v === 1 && d.operator && d.operator.relay && d.operator.blossom && d.operator.api
    && urls(d.relays) && d.relays.length >= 2 && urls(d.indexer) && d.indexer.length >= 1 && urls(d.mirrors) && d.mirrors.length >= 1;
  if (!ok) throw new Error(`${file} isn't a defaults.json as contract 3.1 describes it`);
  // the phone refuses a copy with one (services/defaultsPick.ts validDefaults), so a build must not bake one in (contract 6, FD 119)
  if (/\/$/.test(d.operator.api)) throw new Error(`${file} names the API ${d.operator.api} with a trailing slash, which contract 6 forbids`);
  if (new URL(d.operator.api).origin !== new URL(defaultsUrl).origin) {
    throw new Error(`${file} names the API ${d.operator.api}, but KEFLI_DEFAULTS_URL is ${defaultsUrl}`);
  }
  return d;
}

module.exports = ({ config }) => {
  const local = process.env.KEFLI_VARIANT === 'local';
  const defaultsUrl = local ? 'http://localhost:8447/defaults.json' : process.env.KEFLI_DEFAULTS_URL;
  if (!local && !/^https:\/\//.test(defaultsUrl ?? '')) {
    throw new Error('Set KEFLI_VARIANT=local for the local stack, or KEFLI_DEFAULTS_URL to the operator\'s https defaults.json');
  }
  const file = local
    ? path.join(__dirname, '../../server/staging/defaults.json')
    : path.resolve(__dirname, process.env.KEFLI_DEFAULTS_FILE ?? 'defaults.release.json');
  const baked = bakedDefaults(file, defaultsUrl);
  return {
    ...config,
    plugins: [...config.plugins, ...(local ? ['./plugins/with-local-cleartext'] : [])],
    extra: { ...config.extra, kefli: { variant: local ? 'local' : 'release', defaultsUrl, baked } },
  };
};
