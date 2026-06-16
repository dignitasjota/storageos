'use client';

import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAutomations } from '@/lib/communications/hooks';

const TRIGGER_LABEL: Record<string, string> = {
  customer_created: 'Cliente creado',
  contract_signed: 'Contrato firmado',
  contract_ending_soon: 'Contrato cerca de finalizar',
  contract_ended: 'Contrato finalizado',
  invoice_issued: 'Factura emitida',
  invoice_overdue: 'Factura vencida',
  invoice_paid: 'Factura pagada',
  reservation_confirmed: 'Reserva confirmada',
  lead_created: 'Lead creado',
};

export default function AutomationsPage() {
  const automations = useAutomations();

  if (automations.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Automatizaciones</h1>
        <p className="text-sm text-muted-foreground">
          Reglas que envían mensajes al ocurrir eventos del sistema (ej.: bienvenida tras crear un
          cliente).
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(automations.data ?? []).map((a) => (
          <Card key={a.id}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span>{a.name}</span>
                <Badge variant={a.isActive ? 'default' : 'secondary'}>
                  {a.isActive ? 'Activa' : 'Inactiva'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                <span className="text-muted-foreground">Disparador: </span>
                <strong>{TRIGGER_LABEL[a.trigger] ?? a.trigger}</strong>
              </div>
              <div>
                <span className="text-muted-foreground">Acción: </span>
                <strong>{a.actionType}</strong>{' '}
                {a.templateName && (
                  <span className="text-muted-foreground">→ {a.templateName}</span>
                )}
              </div>
              {a.delayMinutes > 0 && (
                <div className="text-xs text-muted-foreground">
                  Retraso: {a.delayMinutes} min tras el evento
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        {(automations.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No hay reglas configuradas.</p>
        )}
      </div>
    </div>
  );
}
