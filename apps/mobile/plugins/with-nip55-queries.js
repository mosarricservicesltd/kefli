// Lets Kefli see the phone's NIP-55 signer apps (mobile spec 8.4): Android 11 hides other apps unless the manifest
// names what it looks for, here the nostrsigner: scheme.
const { withAndroidManifest } = require('expo/config-plugins');

/** Adds the nostrsigner: query to a parsed manifest, once. */
function addNip55Query(manifest) {
  manifest.queries = manifest.queries ?? [{}];
  const q = manifest.queries[0];
  q.intent = q.intent ?? [];
  const has = q.intent.some((i) => i.data?.some((d) => d.$?.['android:scheme'] === 'nostrsigner'));
  if (!has) q.intent.push({ action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }], data: [{ $: { 'android:scheme': 'nostrsigner' } }] });
  return manifest;
}

module.exports = function withNip55Queries(config) {
  return withAndroidManifest(config, (c) => {
    addNip55Query(c.modResults.manifest);
    return c;
  });
};
module.exports.addNip55Query = addNip55Query;
