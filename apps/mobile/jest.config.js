/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  // jest-expo's own preset already ships a correct transformIgnorePatterns
  // for this SDK's RN/Expo package set — overriding it (as an earlier
  // version of this file did) breaks transformation of those packages'
  // ESM sources. Only the pure-logic units this app can actually verify
  // headlessly (no simulator/renderer available in this environment) are
  // covered — see src/**/__tests__.
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
