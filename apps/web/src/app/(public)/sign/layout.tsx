import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * El enlace de firma es secreto: al salir de la página, las demás solo reciben
 * el origen como página de procedencia, no la dirección con el enlace.
 */
export const metadata: Metadata = { referrer: 'strict-origin' };

export default function SignLayout({ children }: { children: ReactNode }) {
  return children;
}
