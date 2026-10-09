// app.json plus what depends on the build: KEFLI_VARIANT=local points at server/dev's stack and allows cleartext
// to localhost; any other build needs KEFLI_DEFAULTS_URL (https) and allows no cleartext.
//   KEFLI_VARIANT=local npx expo prebuild   (the local stack)
//   KEFLI_DEFAULTS_URL=https://api.<domain>/defaults.json npx expo prebuild
module.exports = ({ config }) => {
  const local = process.env.KEFLI_VARIANT === 'local';
  const defaultsUrl = local ? 'http://localhost:8447/defaults.json' : process.env.KEFLI_DEFAULTS_URL;
  if (!local && !/^https:\/\//.test(defaultsUrl ?? '')) {
    throw new Error('Set KEFLI_VARIANT=local for the local stack, or KEFLI_DEFAULTS_URL to the operator\'s https defaults.json');
  }
  return {
    ...config,
    plugins: [...config.plugins, ...(local ? ['./plugins/with-local-cleartext'] : [])],
    extra: { ...config.extra, kefli: { variant: local ? 'local' : 'release', defaultsUrl } },
  };
};
