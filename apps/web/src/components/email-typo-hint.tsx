'use client';

import { suggestEmailFix } from '@storageos/shared';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

const TEXT = {
  es: { prefix: '¿Querías decir', suffix: '?', fix: 'Corregir' },
  en: { prefix: 'Did you mean', suffix: '?', fix: 'Fix it' },
};

/**
 * «¿Querías decir ana@gmail.com?» bajo un campo de email cuando el dominio
 * parece mal escrito (`@gmial.com`, `@gmail.co`…). Sale cuando se deja de
 * escribir un momento; con «Corregir» se cambia el valor.
 */
export function EmailTypoHint({
  value,
  onAccept,
  locale = 'es',
  className,
}: {
  value: string | null | undefined;
  onAccept: (email: string) => void;
  locale?: string;
  className?: string;
}) {
  const [settled, setSettled] = useState(value ?? '');
  useEffect(() => {
    const t = setTimeout(() => setSettled(value ?? ''), 700);
    return () => clearTimeout(t);
  }, [value]);
  const suggestion = settled && settled === (value ?? '') ? suggestEmailFix(settled) : null;
  if (!suggestion) return null;
  const t = locale.startsWith('en') ? TEXT.en : TEXT.es;
  return (
    <p
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-1.5 text-xs text-amber-700 dark:text-amber-400',
        className,
      )}
    >
      <span>
        {t.prefix} <strong className="break-words font-medium">{suggestion}</strong>
        {t.suffix}
      </span>
      <button
        type="button"
        className="font-medium underline underline-offset-2 hover:no-underline"
        onClick={() => onAccept(suggestion)}
      >
        {t.fix}
      </button>
    </p>
  );
}
