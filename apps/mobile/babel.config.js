// Release builds strip console below warn (mobile spec 7.1): logs never reach a user's phone. Libraries lose their
// warns as well, since those write what they were handed, such as a page's address in react-native-webview's
// "Can't open url" (F25); Kefli's own code has none. The local stack's build (KEFLI_VARIANT=local) keeps them all,
// since testing reads them over adb.
const STRIP = new Set(['log', 'info', 'debug', 'trace']);
const STRIP_VENDOR = new Set([...STRIP, 'warn']);
const VENDOR = /[\\/]node_modules[\\/]/;

function stripConsole({ types: t }) {
  return {
    visitor: {
      CallExpression(path, state) {
        const callee = path.get('callee');
        if (!callee.isMemberExpression() || !callee.get('object').isIdentifier({ name: 'console' })) return;
        const prop = callee.node.property;
        const strip = VENDOR.test(state.filename ?? '') ? STRIP_VENDOR : STRIP;
        if (!t.isIdentifier(prop) || !strip.has(prop.name)) return;
        if (path.parentPath.isExpressionStatement()) path.parentPath.remove();
        else path.replaceWith(t.identifier('undefined'));
      },
    },
  };
}

// The build's variant, written into the bundle as a literal wherever process.env.KEFLI_VARIANT is read, so Metro's
// constant folding drops what only the other variant uses before it collects dependencies: the development gates and
// their fixtures stay out of a release bundle (gates.tsx, F51). Metro's own cache doesn't know the variant, so a
// checkout that switches between the two clears it (expo start --clear); EAS builds start without one.
function inlineVariant(variant) {
  return ({ types: t }) => ({
    visitor: {
      MemberExpression(path) {
        if (path.matchesPattern('process.env.KEFLI_VARIANT')) path.replaceWith(t.stringLiteral(variant));
      },
    },
  });
}

module.exports = function config(api) {
  const variant = process.env.KEFLI_VARIANT === 'local' ? 'local' : 'release';
  api.cache.using(() => variant);
  const keep = variant === 'local';
  return { presets: ['babel-preset-expo'], plugins: [inlineVariant(variant), ...(keep ? [] : [stripConsole])] };
};

module.exports.stripConsole = stripConsole;
module.exports.inlineVariant = inlineVariant;
