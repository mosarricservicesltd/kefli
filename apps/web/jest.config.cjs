// The website's pure scene geometry, run with the other projects from the root jest.config.js.
module.exports = {
  displayName: 'web',
  rootDir: '.',
  roots: ['<rootDir>/test'],
  transform: { '\\.[cm]?[jt]sx?$': ['babel-jest', { configFile: require.resolve('./babel.config.cjs') }] },
  testEnvironment: 'node',
  collectCoverageFrom: ['<rootDir>/src/**/*.ts'],
};
