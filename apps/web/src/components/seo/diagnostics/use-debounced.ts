'use client';

import { useEffect, useState } from 'react';

/** El valor, cuando deja de cambiar durante `ms` (para no pedir al escribir cada letra). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
