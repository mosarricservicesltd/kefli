// Jest on Node for the app's platform-free code (mobile spec 11.1): the data layer and the sender, against
// node:sqlite, and the Reader's logic. Anything that imports React Native is checked on the phone, not here.
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
  collectCoverageFrom: ['<rootDir>/apps/mobile/src/data/**/*.ts', '<rootDir>/apps/mobile/src/services/send.ts', '<rootDir>/apps/mobile/src/services/sync.ts', '<rootDir>/apps/mobile/src/services/images.ts', '<rootDir>/apps/mobile/src/services/page.ts', '<rootDir>/apps/mobile/src/services/pending.ts', '<rootDir>/apps/mobile/src/services/xpost.ts', '<rootDir>/apps/mobile/src/net/**/*.ts', '<rootDir>/apps/mobile/app.config.js',
    '<rootDir>/apps/mobile/src/reader/**/*.ts', '<rootDir>/apps/mobile/src/ui/strings.ts', '<rootDir>/apps/mobile/src/ui/colour.ts',
    '<rootDir>/apps/mobile/src/voice/**/*.ts', '<rootDir>/apps/mobile/src/ui/coverLeaves.ts'],
};
