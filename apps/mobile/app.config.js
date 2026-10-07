// app.json plus what depends on the build: SHELF_VARIANT=local points at server/dev's stack and allows cleartext
// to localhost; any other build needs SHELF_DEFAULTS_URL (https) and allows no cleartext.
//   SHELF_VARIANT=local npx expo prebuild   (the local stack)
//   SHELF_DEFAULTS_URL=https://api.<domain>/defaults.json npx expo prebuild
module.exports = ({ config }) => {
  const local = process.env.SHELF_VARIANT === 'local';
  const defaultsUrl = local ? 'http://localhost:8447/defaults.json' : process.env.SHELF_DEFAULTS_URL;
  if (!local && !/^https:\/\//.test(defaultsUrl ?? '')) {
    throw new Error('Set SHELF_VARIANT=local for the local stack, or SHELF_DEFAULTS_URL to the operator\'s https defaults.json');
  }
  return {
    ...config,
    plugins: [...config.plugins, ...(local ? ['./plugins/with-local-cleartext'] : [])],
    extra: { ...config.extra, shelf: { variant: local ? 'local' : 'release', defaultsUrl } },
  };
};
