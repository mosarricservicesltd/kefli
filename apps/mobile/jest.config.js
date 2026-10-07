// Jest on Node for the app's platform-free code (mobile spec 11.1): the data layer and the sender, against
// node:sqlite. Anything that imports React Native is tested on the phone, not here.
const path = require('path');
module.exports = {
  displayName: 'mobile',
  rootDir: '../..',
  roots: ['<rootDir>/apps/mobile/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '\\.[cm]?[jt]sx?$': ['babel-jest', { configFile: path.join(__dirname, '../../packages/protocol/babel.config.js') }] },
  transformIgnorePatterns: [
    '/node_modules/(?!(@noble|@scure|@exodus|nostr-tools|micromark|mdast-util-|unist-util-|decode-named-character-reference|character-entities|devlop))',
  ],
  testEnvironment: 'node',
  collectCoverageFrom: ['<rootDir>/apps/mobile/src/data/**/*.ts', '<rootDir>/apps/mobile/src/services/send.ts'],
};
