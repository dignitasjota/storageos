'use client';

import { useEffect } from 'react';

import { recordVisit } from '@/lib/attribution';

/** Anota de dónde viene el visitante al entrar en la web del tenant. */
export function AttributionRecorder({ slug }: { slug: string }) {
  useEffect(() => {
    recordVisit(slug);
  }, [slug]);
  return null;
}
