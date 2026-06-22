'use client';

import { FacilitySwitcher } from './facility-switcher';
import { NotificationBell } from './notification-bell';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

import { SidebarTrigger } from '@/components/ui/sidebar';

export function AppHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border/70 bg-app/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-app/60">
      <SidebarTrigger className="-ml-1" />
      <FacilitySwitcher />
      <div className="ml-auto flex items-center gap-1.5">
        <NotificationBell />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
