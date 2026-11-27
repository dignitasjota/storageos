'use client';

import Link from 'next/link';

import type { AiUsageDto } from '@storageos/shared';

import { formatDate, formatNumber } from '@/lib/format';

/** «Este mes: 120 de 300 consultas», en ámbar al 80 % y en rojo al llegar. */
export function UsageLine({ usage }: { usage: AiUsageDto }) {
  if (usage.mode === 'own') {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        Usáis vuestra propia clave de IA
        {usage.ownQueries > 0 ? `: ${formatNumber(usage.ownQueries, 0)} consultas este mes` : ''}.
      </p>
    );
  }
  if (usage.used >= usage.limit && usage.ownKeyConfigured) {
    return (
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
        Se han usado las {formatNumber(usage.limit, 0)} consultas del mes: el asistente sigue con
        vuestra propia clave hasta el {formatDate(usage.resetsOn)}.
      </p>
    );
  }
  const left = Math.max(0, usage.limit - usage.used);
  const ratio = usage.limit > 0 ? usage.used / usage.limit : 1;
  const tone =
    ratio >= 1
      ? 'text-red-600 dark:text-red-400'
      : ratio >= 0.8
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-muted-foreground';
  return (
    <p className={`mt-1 text-xs ${tone}`}>
      Este mes: {formatNumber(usage.used, 0)} de {formatNumber(usage.limit, 0)} consultas
      {ratio >= 1 ? (
        <>
          . Se reinicia el {formatDate(usage.resetsOn)} o{' '}
          <Link href="/settings/saas-billing" className="underline">
            amplíalas con «IA ampliada»
          </Link>
          .
        </>
      ) : ratio >= 0.8 ? (
        <>
          {' '}
          (te quedan {formatNumber(left, 0)}).{' '}
          <Link href="/settings/saas-billing" className="underline">
            Ampliar
          </Link>
        </>
      ) : (
        '.'
      )}
    </p>
  );
}
