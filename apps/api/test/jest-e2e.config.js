/** @type {import('jest').Config} */
module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
  setupFiles: ['<rootDir>/test/helpers/env-setup.ts'],
  testTimeout: 30000,
  clearMocks: true,
  // BullMQ/Stripe/Cron mantienen conexiones abiertas que pueden retrasar
  // el cierre del proceso tras `app.close()`. forceExit lo asegura.
  forceExit: true,
};
