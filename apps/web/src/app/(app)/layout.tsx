import type { ReactNode } from 'react';

import { AppHeader } from '@/components/layout/app-header';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { TrialBanner } from '@/components/layout/trial-banner';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AuthBootstrap } from '@/lib/auth/bootstrap';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthBootstrap>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="bg-app">
          <AppHeader />
          <TrialBanner />
          <div className="flex-1">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </AuthBootstrap>
  );
}
