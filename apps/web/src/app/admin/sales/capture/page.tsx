'use client';

import { QuickCaptureForm } from '@/components/admin/leads/quick-capture-form';

/** Alta rápida de un prospecto desde el móvil: va a la cartera del comercial. */
export default function SalesCapturePage() {
  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Alta rápida</h1>
        <p className="text-sm text-muted-foreground">
          Un contacto de una feria o una visita: lo justo para no perderlo. Va a tu cartera.
        </p>
      </div>
      <QuickCaptureForm sales />
    </div>
  );
}
