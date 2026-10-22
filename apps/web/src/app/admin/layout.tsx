import { AdminLayoutClient } from './admin-layout-client';

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { PwaRegister } from '@/components/pwa/pwa-register';

// El panel del super admin es su propia PWA instalable (scope /admin), aparte
// de la del equipo del tenant y la del inquilino. Comparten el service worker.
export const metadata: Metadata = {
  manifest: '/manifest-admin.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'TrasterOS Admin' },
};

export const viewport: Viewport = {
  viewportFit: 'cover',
  themeColor: '#0f172a',
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PwaRegister />
      <AdminLayoutClient>{children}</AdminLayoutClient>
    </>
  );
}
