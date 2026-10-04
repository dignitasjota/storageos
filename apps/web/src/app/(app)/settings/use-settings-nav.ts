'use client';

import { SETTINGS_NAV, type SettingsNavGroup } from './settings-nav';

import { usePermissions } from '@/lib/auth/hooks';

/** Grupos visibles según los permisos del usuario (los vacíos desaparecen). */
export function useVisibleSettingsNav(): SettingsNavGroup[] {
  const permissions = usePermissions();
  return SETTINGS_NAV.map((group) => ({
    ...group,
    items: group.items.filter((i) => !i.permission || permissions.includes(i.permission)),
  })).filter((g) => g.items.length > 0);
}
