import { useEffect } from 'react';

/** Abre el alta de una lista al llegar con `?new=1` (accesos directos del Resumen). */
export function useOpenFromUrl(open: () => void) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('new') !== '1') return;
    url.searchParams.delete('new');
    window.history.replaceState(null, '', url);
    open();
    // Solo al entrar en la página.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
