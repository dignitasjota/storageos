'use client';

import { FacilitySwitcher } from './facility-switcher';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

import { SidebarTrigger } from '@/components/ui/sidebar';

export function AppHeader() {
  return (
    <header className="flex h-14 items-center gap-3 border-b border-border bg-background px-4">
      <SidebarTrigger />
      <FacilitySwitcher />
      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
