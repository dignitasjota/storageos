'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { type ReactNode, useState } from 'react';
import { Toaster } from 'sonner';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  // El ThemeProvider (next-themes) vive ahora por sección (panel normal vs admin)
  // para que cada una tenga su propio tema por defecto y preferencia: ver
  // `(app)/layout.tsx` (system) y `admin/layout.tsx` (dark). Son grupos de rutas
  // hermanos que nunca coexisten, así que no hay conflicto de doble provider.
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster position="top-right" richColors closeButton />
      {process.env.NODE_ENV !== 'production' ? (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />
      ) : null}
    </QueryClientProvider>
  );
}
