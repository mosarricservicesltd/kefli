// Every test suite in one run, so the code-gate reads one coverage report: the protocol package, the
// app's platform-free data layer, the website's scene geometry and the extension's modules.
module.exports = {
  projects: ['<rootDir>/packages/protocol/jest.config.js', '<rootDir>/apps/mobile/jest.config.js', '<rootDir>/apps/web/jest.config.cjs', '<rootDir>/apps/extension/jest.config.js'],
};
