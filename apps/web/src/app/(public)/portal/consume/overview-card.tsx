'use client';

import {
  AlertCircle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  CreditCard,
  KeyRound,
  MessageSquare,
  Plus,
  Wallet,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { intlLocaleForPortal, type PortalLocale } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalContractDto, PortalInvoiceDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function eur(n: number, locale: PortalLocale): string {
  return n.toLocaleString(intlLocaleForPortal(locale), { style: 'currency', currency: 'EUR' });
}

function fmtDate(iso: string | null, locale: PortalLocale): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(intlLocaleForPortal(locale), {
    day: 'numeric',
    month: 'long',
  });
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
  const t = useTranslations('portal.consume.overview');
  const { locale } = usePortalLocale();
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
      text: t('overdueInvoices', { count: overdue.length }),
      tab: 'facturas',
    });
  }
  if (unreadMessages > 0) {
    alerts.push({
      icon: MessageSquare,
      text: t('unreadMessages', { count: unreadMessages }),
      tab: 'mensajes',
    });
  }
  if (ending.length > 0) {
    alerts.push({
      icon: AlertCircle,
      text: t('moveOutInProgress'),
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
              {t('helloFirstName', { name: customerName.split(' ')[0] })}
            </p>
            {totalPending > 0 ? (
              <>
                <p className="mt-1 text-3xl font-semibold tracking-tight">
                  {eur(totalPending, locale)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('pendingPayment')}
                  {nextDue?.dueDate ? t('nextDue', { date: fmtDate(nextDue.dueDate, locale) }) : ''}
                </p>
              </>
            ) : (
              <p className="mt-1 flex items-center gap-2 text-lg font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-5" /> {t('upToDate')}
              </p>
            )}
          </div>
          {totalPending > 0 && (
            <Button
              onClick={() => onNavigate('facturas')}
              style={accent ? { backgroundColor: accent } : undefined}
            >
              <Wallet className="mr-1 size-4" /> {t('payNow')}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Avisos */}
      {alerts.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('alertsTitle')}</CardTitle>
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

      {/* Accesos rápidos — lanzador «tipo app» (grande y táctil) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <QuickAction
          icon={CreditCard}
          tint="bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300"
          label={pending.length > 0 ? t('quickPay') : t('quickInvoices')}
          hint={
            pending.length > 0
              ? t('quickPendingCount', { count: pending.length })
              : t('quickUpToDate')
          }
          onClick={() => onNavigate('facturas')}
        />
        <QuickAction
          icon={Boxes}
          tint="bg-cyan-100 text-cyan-600 dark:bg-cyan-950 dark:text-cyan-300"
          label={t('quickMyUnits')}
          hint={t('quickActiveCount', { count: activeContracts.length })}
          onClick={() => onNavigate('contratos')}
        />
        <QuickAction
          icon={KeyRound}
          tint="bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
          label={t('quickMyAccess')}
          hint={t('quickAccessHint')}
          onClick={() => onNavigate('accesos')}
        />
        <QuickAction
          icon={MessageSquare}
          tint="bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-300"
          label={t('quickMessages')}
          hint={
            unreadMessages > 0 ? t('quickUnreadCount', { count: unreadMessages }) : t('quickChat')
          }
          badge={unreadMessages}
          onClick={() => onNavigate('mensajes')}
        />
        <QuickAction
          icon={AlertCircle}
          tint="bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-300"
          label={t('quickIncidents')}
          hint={t('quickReport')}
          onClick={() => onNavigate('incidencias')}
        />
        <QuickAction
          icon={Plus}
          tint="bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-300"
          label={t('quickContract')}
          hint={t('quickOtherUnit')}
          onClick={() => onNavigate('nuevo')}
        />
      </div>
    </div>
  );
}

function QuickAction({
  icon: Icon,
  tint,
  label,
  hint,
  badge = 0,
  onClick,
}: {
  icon: typeof Boxes;
  tint: string;
  label: string;
  hint: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex flex-col items-center gap-2 rounded-2xl border border-border bg-card p-5 text-center shadow-sm transition-colors active:bg-accent hover:bg-muted"
    >
      <span className={`flex size-12 items-center justify-center rounded-full ${tint}`}>
        <Icon className="size-6" />
      </span>
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
      {badge > 0 && (
        <span className="absolute right-3 top-3 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500 px-1 text-xs font-medium text-white">
          {badge}
        </span>
      )}
    </button>
  );
}
