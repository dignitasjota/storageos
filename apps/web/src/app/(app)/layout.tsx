import { ThemeProvider } from 'next-themes';

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { AppHeader } from '@/components/layout/app-header';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { PlatformBanner } from '@/components/layout/platform-banner';
import { TrialBanner } from '@/components/layout/trial-banner';
import { PwaRegister } from '@/components/pwa/pwa-register';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AuthBootstrap } from '@/lib/auth/bootstrap';

// El panel del staff es su propia PWA instalable (manifest distinto del portal
// del inquilino, que tiene scope /portal). Comparten el mismo service worker.
export const metadata: Metadata = {
  manifest: '/manifest-staff.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'StorageOS' },
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <PwaRegister />
      <AuthBootstrap>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset className="bg-app">
            <AppHeader />
            <PlatformBanner />
            <TrialBanner />
            <div className="flex-1">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </AuthBootstrap>
    </ThemeProvider>
  );
}
