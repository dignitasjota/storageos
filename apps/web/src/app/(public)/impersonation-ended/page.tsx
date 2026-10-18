import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sesión de soporte terminada',
  robots: { index: false, follow: false },
};

/** Despedida de una sesión de soporte (impersonación) del panel admin. */
export default function ImpersonationEndedPage() {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Sesión de soporte terminada</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Ya no estás dentro del panel del tenant. Puedes cerrar esta pestaña y volver al panel de
        administración.
      </p>
    </div>
  );
}
