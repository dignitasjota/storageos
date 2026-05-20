/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  // Cogemos los unit specs de `src/**/__tests__/*.spec.ts` y de
  // `test/*.spec.ts` (estos ultimos son utiles cuando un builder/helper no
  // pertenece claramente a un modulo). Los e2e (`*.e2e-spec.ts`) corren con
  // `test:e2e` y un config separado.
  testMatch: ['**/__tests__/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.e2e-spec\\.ts$'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
  testTimeout: 15000,
  clearMocks: true,
};
