'use client';

import Link from 'next/link';

import { useCustomerDuplicates } from '@/lib/customers/hooks';

const MATCH_LABEL = { email: 'email', phone: 'teléfono', document: 'documento' } as const;

/** Aviso, sin bloquear: un email compartido en una familia es legítimo. */
export function DuplicateWarning(props: {
  email?: string | null | undefined;
  phone?: string | null | undefined;
  documentNumber?: string | null | undefined;
  excludeId?: string;
}) {
  const duplicates = useCustomerDuplicates(props).data ?? [];
  if (duplicates.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <p className="font-medium">Puede que ya exista:</p>
      <ul className="mt-1 space-y-0.5">
        {duplicates.map((d) => (
          <li key={d.id}>
            <Link href={`/customers/${d.id}`} target="_blank" className="underline">
              {d.displayName}
            </Link>{' '}
            (mismo {d.matches.map((m) => MATCH_LABEL[m]).join(' y ')})
          </li>
        ))}
      </ul>
    </div>
  );
}
