'use client';

import { ClipboardList, CreditCard, FileText, UserPlus } from 'lucide-react';
import Link from 'next/link';

import type { Permission } from '@storageos/shared';
import type { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { usePermissions } from '@/lib/auth/hooks';

interface Action {
  href: string;
  label: string;
  icon: typeof Plus;
  permission: Permission;
}

const ACTIONS: Action[] = [
  {
    href: '/contracts/new',
    label: 'Nuevo contrato',
    icon: FileText,
    permission: 'contracts:write',
  },
  { href: '/customers', label: 'Nuevo inquilino', icon: UserPlus, permission: 'customers:write' },
  { href: '/invoices', label: 'Nueva factura', icon: CreditCard, permission: 'invoices:write' },
  { href: '/tasks', label: 'Nueva tarea', icon: ClipboardList, permission: 'tasks:write' },
];

/** Accesos directos a las altas más frecuentes desde el dashboard. */
export function QuickActions() {
  const permissions = usePermissions();
  const visible = ACTIONS.filter((a) => permissions.includes(a.permission));
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {visible.map((a) => {
        const Icon = a.icon;
        return (
          <Button key={a.href} asChild variant="outline" size="sm">
            <Link href={a.href}>
              <Icon className="mr-1 size-4" /> {a.label}
            </Link>
          </Button>
        );
      })}
    </div>
  );
}
