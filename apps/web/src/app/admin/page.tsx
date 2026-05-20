'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Redirect raiz del panel admin: enviamos a /admin/metrics. */
export default function AdminIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/metrics');
  }, [router]);
  return null;
}
