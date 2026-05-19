'use client';

import { LogOut, ShieldOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLogout, useLogoutAll, useMe } from '@/lib/auth/hooks';

function initials(name: string | undefined): string {
  if (!name) return '·';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return (
    parts
      .map((p) => p[0]?.toUpperCase())
      .filter(Boolean)
      .join('') || '·'
  );
}

export function UserMenu() {
  const t = useTranslations('appHeader.userMenu');
  const router = useRouter();
  const me = useMe();
  const logout = useLogout();
  const logoutAll = useLogoutAll();

  const onLogout = async () => {
    await logout.mutateAsync();
    router.replace('/login');
  };
  const onLogoutAll = async () => {
    await logoutAll.mutateAsync();
    router.replace('/login');
  };

  const fullName = me.data?.user.fullName;
  const email = me.data?.user.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="size-9 rounded-full p-0" aria-label="Menu de usuario">
          <Avatar className="size-9">
            <AvatarFallback>{initials(fullName)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="space-y-0.5">
          <p className="truncate text-sm">{fullName ?? '...'}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">{email ?? ''}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onLogout}>
          <LogOut className="mr-2 size-4" aria-hidden />
          {t('logout')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onLogoutAll}>
          <ShieldOff className="mr-2 size-4" aria-hidden />
          {t('logoutAll')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
