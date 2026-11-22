'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

import { QuickCaptureForm } from '@/components/admin/leads/quick-capture-form';
import { Button } from '@/components/ui/button';

/** Alta rápida de un lead desde el móvil (ferias, visitas, llamadas). */
export default function AdminLeadCapturePage() {
  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-4">
      <Button variant="ghost" size="sm" className="-ml-2" asChild>
        <Link href="/admin/leads">
          <ArrowLeft className="mr-1 size-4" aria-hidden /> Leads
        </Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Alta rápida</h1>
        <p className="text-sm text-muted-foreground">
          Lo justo para no perderlo: luego completas la ficha. Guárdala en la pantalla de inicio del
          móvil para tenerla a mano.
        </p>
      </div>
      <QuickCaptureForm />
    </div>
  );
}
