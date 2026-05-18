import config from '@storageos/eslint-config/base';

export default [
  ...config,
  {
    ignores: ['node_modules/.prisma/**', 'prisma/migrations/**'],
  },
];
