// The extension's platform-free modules under Jest, in the root run so the code-gate reads one coverage report. The
// protocol package's Babel config, since the extension imports its source; ESM-only dependencies are transformed too.
module.exports = {
  displayName: 'extension',
  rootDir: '../..',
  roots: ['<rootDir>/apps/extension/test'],
  transform: { '\\.[cm]?[jt]sx?$': ['babel-jest', { configFile: require.resolve('../../packages/protocol/babel.config.js') }] },
  transformIgnorePatterns: [
    '/node_modules/(?!(@noble|@scure|@exodus|nostr-tools|micromark|mdast-util-|unist-util-|decode-named-character-reference|character-entities|devlop|toqr))',
  ],
  moduleNameMapper: { '\\.svg$': '<rootDir>/apps/extension/test/svgStub.js' },
  testEnvironment: 'node',
  collectCoverageFrom: ['<rootDir>/apps/extension/src/**/*.ts'],
};
