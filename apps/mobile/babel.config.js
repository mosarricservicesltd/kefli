// Release builds strip console below warn (mobile spec 7.1): logs never reach a user's phone. The local stack's build
// (KEFLI_VARIANT=local) keeps them, since testing reads them over adb.
const STRIP = new Set(['log', 'info', 'debug', 'trace']);

function stripConsole({ types: t }) {
  return {
    visitor: {
      CallExpression(path) {
        const callee = path.get('callee');
        if (!callee.isMemberExpression() || !callee.get('object').isIdentifier({ name: 'console' })) return;
        const prop = callee.node.property;
        if (!t.isIdentifier(prop) || !STRIP.has(prop.name)) return;
        if (path.parentPath.isExpressionStatement()) path.parentPath.remove();
        else path.replaceWith(t.identifier('undefined'));
      },
    },
  };
}

module.exports = function config(api) {
  const keep = process.env.KEFLI_VARIANT === 'local';
  api.cache.using(() => String(keep));
  return { presets: ['babel-preset-expo'], plugins: keep ? [] : [stripConsole] };
};

module.exports.stripConsole = stripConsole;
