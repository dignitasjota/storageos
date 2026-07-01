'use client';

import { FacilitySwitcher } from './facility-switcher';
import { GlobalSearch } from './global-search';
import { NotificationBell } from './notification-bell';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

import { SidebarTrigger } from '@/components/ui/sidebar';

export function AppHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border/70 bg-app/80 px-3 backdrop-blur supports-[backdrop-filter]:bg-app/60 sm:gap-3 sm:px-4">
      <SidebarTrigger className="-ml-1 shrink-0" />
      <FacilitySwitcher />
      <GlobalSearch />
      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1.5">
        <NotificationBell />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
