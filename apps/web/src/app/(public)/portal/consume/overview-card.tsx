'use client';

import {
  AlertCircle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  CreditCard,
  KeyRound,
  MessageSquare,
  Wallet,
} from 'lucide-react';

import type { PortalContractDto, PortalInvoiceDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function eur(n: number): string {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
}

/**
 * Pantalla de inicio del portal: lo importante de un vistazo (saldo pendiente,
 * próximo vencimiento, avisos) + accesos rápidos al resto de pestañas.
 * Frontend-only: deriva todo del estado ya cargado por la página.
 */
export function OverviewCard({
  customerName,
  invoices,
  contracts,
  unreadMessages,
  brandColor,
  onNavigate,
}: {
  customerName: string;
  invoices: PortalInvoiceDto[];
  contracts: PortalContractDto[];
  unreadMessages: number;
  brandColor: string | null;
  onNavigate: (tab: string) => void;
}) {
  const pending = invoices.filter((i) => i.amountPending > 0);
  const totalPending = pending.reduce((s, i) => s + i.amountPending, 0);
  const overdue = invoices.filter((i) => i.status === 'overdue');
  const nextDue = [...pending].sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))[0];
  const activeContracts = contracts.filter((c) => c.status === 'active' || c.status === 'ending');
  const ending = contracts.filter((c) => c.status === 'ending');

  const alerts: { icon: typeof AlertCircle; text: string; tab: string }[] = [];
  if (overdue.length > 0) {
    alerts.push({
      icon: AlertCircle,
      text: `Tienes ${overdue.length} factura${overdue.length > 1 ? 's' : ''} vencida${overdue.length > 1 ? 's' : ''}.`,
      tab: 'facturas',
    });
  }
  if (unreadMessages > 0) {
    alerts.push({
      icon: MessageSquare,
      text: `Tienes ${unreadMessages} mensaje${unreadMessages > 1 ? 's' : ''} sin leer de tu gestor.`,
      tab: 'mensajes',
    });
  }
  if (ending.length > 0) {
    alerts.push({
      icon: AlertCircle,
      text: `Tienes una baja en curso. Revisa los detalles en tus contratos.`,
      tab: 'contratos',
    });
  }

  const accent = brandColor ?? undefined;

  return (
    <div className="space-y-4">
      {/* Saldo pendiente */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm text-muted-foreground">
              Hola {customerName.split(' ')[0]}, esto es lo importante
            </p>
            {totalPending > 0 ? (
              <>
                <p className="mt-1 text-3xl font-semibold tracking-tight">{eur(totalPending)}</p>
                <p className="text-sm text-muted-foreground">
                  pendiente de pago
                  {nextDue?.dueDate ? ` · próximo vencimiento ${fmtDate(nextDue.dueDate)}` : ''}
                </p>
              </>
            ) : (
              <p className="mt-1 flex items-center gap-2 text-lg font-medium text-emerald-600">
                <CheckCircle2 className="size-5" /> Estás al día con tus pagos
              </p>
            )}
          </div>
          {totalPending > 0 && (
            <Button
              onClick={() => onNavigate('facturas')}
              style={accent ? { backgroundColor: accent } : undefined}
            >
              <Wallet className="mr-1 size-4" /> Pagar ahora
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Avisos */}
      {alerts.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Avisos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {alerts.map((a, idx) => {
              const Icon = a.icon;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => onNavigate(a.tab)}
                  className="flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors hover:bg-muted"
                >
                  <Icon className="size-4 shrink-0 text-amber-500" />
                  <span className="flex-1">{a.text}</span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Accesos rápidos */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <QuickAction
          icon={Boxes}
          label="Mis trasteros"
          hint={`${activeContracts.length}`}
          onClick={() => onNavigate('contratos')}
        />
        <QuickAction
          icon={CreditCard}
          label="Facturas"
          hint={pending.length > 0 ? `${pending.length} pend.` : 'Al día'}
          onClick={() => onNavigate('facturas')}
        />
        <QuickAction
          icon={KeyRound}
          label="Mi acceso"
          hint="PIN / QR"
          onClick={() => onNavigate('accesos')}
        />
        <QuickAction
          icon={MessageSquare}
          label="Mensajes"
          hint={unreadMessages > 0 ? `${unreadMessages} sin leer` : 'Chat'}
          onClick={() => onNavigate('mensajes')}
        />
      </div>
    </div>
  );
}

function QuickAction({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: typeof Boxes;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors hover:bg-muted"
    >
      <Icon className="size-5 text-muted-foreground" />
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}
