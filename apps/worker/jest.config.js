/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
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
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 15000,
  clearMocks: true,
  // Redirige `ioredis` a `ioredis-mock` para que BullMQ no abra conexiones
  // reales a Redis durante el bootstrap del worker en tests. Funciona a nivel
  // resolver (antes de cualquier import), por lo que no requiere `jest.mock`.
  moduleNameMapper: {
    '^ioredis$': 'ioredis-mock',
  },
};
