'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { adminRealtimeResponse } from '@/lib/admin/api';
import { useRealtimeStore } from '@/lib/realtime/store';
import { listenRealtime } from '@/lib/realtime/stream';

/** Los tickets se ven al momento en el panel admin. */
export function AdminRealtimeListener() {
  const qc = useQueryClient();
  const setConnected = useRealtimeStore((s) => s.setConnected);

  useEffect(() => {
    const abort = new AbortController();
    void listenRealtime(
      adminRealtimeResponse,
      () => void qc.invalidateQueries({ queryKey: ['admin', 'support'] }),
      setConnected,
      abort.signal,
    );
    return () => abort.abort();
  }, [qc, setConnected]);

  return null;
}
