// Every test suite in one run, so the code-gate reads one coverage report: the protocol package, the
// app's platform-free data layer and the website's scene geometry.
module.exports = {
  projects: ['<rootDir>/packages/protocol/jest.config.js', '<rootDir>/apps/mobile/jest.config.js', '<rootDir>/apps/web/jest.config.cjs'],
};
