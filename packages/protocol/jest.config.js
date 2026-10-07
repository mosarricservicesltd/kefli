// ESM-only dependencies are transformed too (mobile spec 2.4, plus @exodus/bytes under whatwg-url and character-entities under decode-named-character-reference);
// shared/ sits outside this package, so the root is the repository.
module.exports = {
  displayName: 'protocol',
  rootDir: '../..',
  roots: ['<rootDir>/packages/protocol/test'],
  transform: { '\\.[cm]?[jt]sx?$': ['babel-jest', { configFile: require.resolve('./babel.config.js') }] },
  transformIgnorePatterns: [
    '/node_modules/(?!(@noble|@scure|@exodus|nostr-tools|micromark|mdast-util-|unist-util-|decode-named-character-reference|character-entities|devlop))',
  ],
  testEnvironment: 'node',
  // What the code-gate's coverage covers: the package, its tools and the normalise reference.
  collectCoverageFrom: ['<rootDir>/packages/protocol/src/**/*.ts', '<rootDir>/packages/protocol/tools/**/*.ts', '<rootDir>/shared/normalise.ts'],
};
