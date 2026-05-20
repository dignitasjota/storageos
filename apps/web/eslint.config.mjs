import config from '@storageos/eslint-config/next';

export default [
  ...config,
  {
    ignores: ['.next/**', 'next-env.d.ts', 'e2e/**', 'playwright-report/**', 'test-results/**'],
  },
];
