'use client';

import { useEffect, useState } from 'react';

/**
 * Paginación en el cliente para listas largas del panel: enseña `pageSize`
 * elementos y «Cargar más» suma otros tantos. Vuelve al principio cuando
 * cambian los filtros (`resetKey`).
 */
export function useLoadMore<T>(items: T[], pageSize = 25, resetKey: unknown = null) {
  const [count, setCount] = useState(pageSize);
  useEffect(() => {
    setCount(pageSize);
  }, [resetKey, pageSize]);
  return {
    visible: items.slice(0, count),
    hasMore: items.length > count,
    remaining: Math.max(0, items.length - count),
    loadMore: () => setCount((c) => c + pageSize),
  };
}
