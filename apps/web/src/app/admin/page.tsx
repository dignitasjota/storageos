'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useAdminAuthStore } from '@/lib/admin/auth-store';

/** Raíz del panel admin: a Métricas (o al «Hoy» del comercial). */
export default function AdminIndexPage() {
  const router = useRouter();
  const role = useAdminAuthStore((s) => s.superAdmin?.role);
  useEffect(() => {
    if (!role) return;
    router.replace(role === 'sales' ? '/admin/sales' : '/admin/metrics');
  }, [router, role]);
  return null;
}
