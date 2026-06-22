import type { Config } from 'tailwindcss';

import preset from '@storageos/tailwind-config';

const config: Config = {
  darkMode: ['class'],
  presets: [preset as Config],
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/lib/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        app: 'hsl(var(--app) / <alpha-value>)',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 24 40 / 0.04), 0 1px 3px 0 rgb(16 24 40 / 0.04)',
        soft: '0 6px 24px -8px rgb(16 24 40 / 0.10)',
      },
    },
  },
};

export default config;
