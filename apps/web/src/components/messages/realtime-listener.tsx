'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { apiFetchResponse } from '@/lib/auth/api';
import { useAuthStore } from '@/lib/auth/store';
import { useRealtimeStore } from '@/lib/realtime/store';
import { listenRealtime } from '@/lib/realtime/stream';

/** Mantiene al día mensajes y tickets del panel sin esperar al siguiente refresco. */
export function RealtimeListener() {
  const qc = useQueryClient();
  const signedIn = useAuthStore((s) => Boolean(s.accessToken));
  const setConnected = useRealtimeStore((s) => s.setConnected);

  useEffect(() => {
    if (!signedIn) return;
    const abort = new AbortController();
    void listenRealtime(
      (signal) => apiFetchResponse('/realtime/stream', { signal }),
      (event) => {
        if (event.type === 'ticket') {
          void qc.invalidateQueries({ queryKey: ['support'] });
          return;
        }
        void qc.invalidateQueries({ queryKey: ['customers', 'unread-summary'] });
        void qc.invalidateQueries({ queryKey: ['messages', 'inbox'] });
        if (event.customerId) {
          void qc.invalidateQueries({ queryKey: ['customers', event.customerId, 'messages'] });
          void qc.invalidateQueries({ queryKey: ['messages', 'context', event.customerId] });
        }
      },
      setConnected,
      abort.signal,
    );
    return () => abort.abort();
  }, [signedIn, qc, setConnected]);

  return null;
}
