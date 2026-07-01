'use client';

import {
  AlertTriangle,
  Boxes,
  ClipboardList,
  CreditCard,
  FileText,
  KeyRound,
  Search,
  Sun,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';

import type { Permission, TenantFeature } from '@storageos/shared';

import { useFeatures, useMe, usePermissions } from '@/lib/auth/hooks';
import { useToday } from '@/lib/dashboard/hooks';

type Action = {
  href: string;
  label: string;
  icon: typeof Sun;
  /** Color de acento del icono (tailwind). */
  tint: string;
  permission?: Permission;
  feature?: TenantFeature;
};

const ACTIONS: Action[] = [
  { href: '/today', label: 'Hoy', icon: Sun, tint: 'bg-amber-100 text-amber-600' },
  {
    href: '/contracts/new',
    label: 'Nuevo contrato',
    icon: FileText,
    tint: 'bg-blue-100 text-blue-600',
    permission: 'contracts:write',
  },
  {
    href: '/invoices',
    label: 'Cobros',
    icon: CreditCard,
    tint: 'bg-emerald-100 text-emerald-600',
    permission: 'invoices:read',
  },
  {
    href: '/customers',
    label: 'Inquilinos',
    icon: UserPlus,
    tint: 'bg-violet-100 text-violet-600',
    permission: 'customers:read',
  },
  {
    href: '/units',
    label: 'Trasteros',
    icon: Boxes,
    tint: 'bg-cyan-100 text-cyan-600',
    permission: 'units:read',
  },
  {
    href: '/access',
    label: 'Accesos',
    icon: KeyRound,
    tint: 'bg-slate-200 text-slate-700',
    permission: 'access:read',
    feature: 'access_control',
  },
  {
    href: '/incidents',
    label: 'Incidencias',
    icon: AlertTriangle,
    tint: 'bg-red-100 text-red-600',
    permission: 'incidents:read',
  },
  {
    href: '/tasks',
    label: 'Tareas',
    icon: ClipboardList,
    tint: 'bg-orange-100 text-orange-600',
    permission: 'tasks:read',
  },
];

/**
 * Home «tipo app» del staff en móvil: un lanzador de acciones grandes y táctiles
 * para lo más frecuente, en vez del dashboard de métricas (que va apilado abajo
 * en escritorio). Solo se muestra en móvil; el resto navega por el drawer.
 */
export function MobileHome() {
  const me = useMe();
  const features = useFeatures();
  const permissions = usePermissions();
  const today = useToday();
  const canAccess = (a: Action) =>
    (!a.permission || permissions.includes(a.permission)) &&
    (!a.feature || features.includes(a.feature));

  const urgent = today.data?.urgentCount ?? 0;
  const firstName = me.data?.user.fullName?.split(' ')[0] ?? '';

  return (
    <div className="space-y-5 px-4 py-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Hola{firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="text-sm text-muted-foreground">¿Qué quieres hacer?</p>
      </div>

      {/* Búsqueda grande (lleva a clientes; el ⌘K del header también funciona) */}
      <Link
        href="/customers"
        className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      >
        <Search className="size-4" /> Buscar inquilino, contrato…
      </Link>

      <div className="grid grid-cols-2 gap-3">
        {ACTIONS.filter(canAccess).map((a) => {
          const Icon = a.icon;
          const showBadge = a.href === '/today' && urgent > 0;
          return (
            <Link
              key={a.href}
              href={a.href}
              className="relative flex flex-col items-center gap-2 rounded-2xl border border-border bg-card p-5 shadow-card transition-colors active:bg-accent"
            >
              <span className={`flex size-12 items-center justify-center rounded-full ${a.tint}`}>
                <Icon className="size-6" />
              </span>
              <span className="text-center text-sm font-medium">{a.label}</span>
              {showBadge && (
                <span className="absolute right-3 top-3 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-xs font-medium text-white">
                  {urgent}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
