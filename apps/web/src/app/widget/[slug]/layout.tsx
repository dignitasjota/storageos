import { type ReactNode } from 'react';

/**
 * Layout aislado del widget: sin nav, sin sidebar, sin auth. Pensado
 * para embebido en iframe en webs externas. Permite todo origen como
 * frame-ancestors via meta http-equiv (las cabeceras se aplican aparte
 * en `middleware.ts`).
 */
export const metadata = {
  title: 'Reserva tu trastero',
  description: 'Solicitud de reserva',
};

export default function WidgetLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-md p-4">{children}</div>
    </div>
  );
}
