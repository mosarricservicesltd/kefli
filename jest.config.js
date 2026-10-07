// Both test suites in one run, so the code-gate reads one coverage report: the protocol package and the
// app's platform-free data layer.
module.exports = {
  projects: ['<rootDir>/packages/protocol/jest.config.js', '<rootDir>/apps/mobile/jest.config.js'],
};
