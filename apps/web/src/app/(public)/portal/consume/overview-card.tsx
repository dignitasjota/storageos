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

import type { PortalAccountDto, PortalContractDto, PortalInvoiceDto } from '@storageos/shared';

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
  account,
  brandColor,
  onNavigate,
}: {
  customerName: string;
  invoices: PortalInvoiceDto[];
  contracts: PortalContractDto[];
  unreadMessages: number;
  account: PortalAccountDto | null;
  brandColor: string | null;
  onNavigate: (tab: string) => void;
}) {
  const t = useTranslations('portal.consume.overview');
  const { locale } = usePortalLocale();
  // Lo que ya se está cobrando (adeudo en curso o en remesa) no es algo que
  // tenga que pagar: no cuenta en el saldo ni en los avisos.
  const pending = invoices.filter((i) => i.amountPending > 0 && !i.paymentInProgress);
  const totalPending = pending.reduce((s, i) => s + i.amountPending, 0);
  const inProgress = invoices
    .filter((i) => i.amountPending > 0 && i.paymentInProgress)
    .reduce((s, i) => s + i.amountPending, 0);
  const overdue = invoices.filter((i) => i.status === 'overdue' && !i.paymentInProgress);
  const nextDue = [...pending].sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))[0];
  const activeContracts = contracts.filter((c) => c.status === 'active' || c.status === 'ending');
  const ending = contracts.filter((c) => c.status === 'ending');

  const alerts: { icon: typeof AlertCircle; text: string; tab: string }[] = [];
  // Con «Mi cuenta» la deuda ya sale explicada: no se repite como aviso.
  if (overdue.length > 0 && !account?.overdue) {
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
            {inProgress > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('inProgress', { amount: eur(inProgress, locale) })}
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

      {account && account.lines.length > 0 && (
        <AccountCard account={account} onNavigate={onNavigate} />
      )}

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

/** Fecha corta con día de la semana para pasos y cargos. */
function fmtDay(iso: string, locale: PortalLocale): string {
  return new Date(iso).toLocaleDateString(intlLocaleForPortal(locale), {
    day: 'numeric',
    month: 'long',
  });
}

/**
 * «Mi cuenta»: lo que paga cada mes (con IVA), cómo se le cobra y el próximo
 * cargo; si debe algo, qué pasará y cuándo si no paga.
 */
function AccountCard({
  account,
  onNavigate,
}: {
  account: PortalAccountDto;
  onNavigate: (tab: string) => void;
}) {
  const t = useTranslations('portal.consume.overview.account');
  const { locale } = usePortalLocale();
  const payLabel =
    account.payVia === 'card'
      ? t('payCard', {
          brand: account.payBrand
            ? account.payBrand.charAt(0).toUpperCase() + account.payBrand.slice(1)
            : t('cardFallback'),
          last4: account.payLast4 ?? '····',
        })
      : account.payVia === 'sepa_debit' || account.payVia === 'sepa_mandate'
        ? t('payDebit', { last4: account.payLast4 ?? '····' })
        : null;
  const upcoming =
    account.overdue?.steps.filter((s) => !s.done && s.type !== 'email_reminder') ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {account.overdue && (
          <div className="space-y-2 rounded-md border border-red-300 bg-red-50 p-3 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <p className="font-medium">
              {t('overdue', {
                amount: eur(account.overdue.amount, locale),
                days: account.overdue.days,
              })}
            </p>
            {account.overdue.accessBlocked ? (
              <p>{t('accessBlocked')}</p>
            ) : (
              upcoming.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5">
                  {upcoming.map((s) => (
                    <li key={`${s.type}-${s.date}`}>
                      {t(`step.${s.type}`, { date: fmtDay(s.date, locale) })}
                    </li>
                  ))}
                </ul>
              )
            )}
            <Button size="sm" variant="destructive" onClick={() => onNavigate('facturas')}>
              {t('payOverdue')}
            </Button>
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">{t('monthly')}</span>
            <span className="text-lg font-semibold tabular-nums">
              {eur(account.monthly, locale)}
            </span>
          </div>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {account.lines.map((l) => (
              <li key={l.contractId} className="flex justify-between gap-3">
                <span>
                  {l.unitCode} · {l.facilityName}
                  {l.insurance > 0 &&
                    ` · ${t('withInsurance', { amount: eur(l.insurance, locale) })}`}
                  {l.billingIntervalMonths > 1 &&
                    ` · ${t('prepaid', { months: l.billingIntervalMonths })}`}
                  {l.ending && ` · ${t('ending')}`}
                </span>
                <span className="tabular-nums">{eur(l.total, locale)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('vatIncluded')}</p>
        </div>

        {account.nextCharge && (
          <div className="flex items-baseline justify-between gap-3 border-t pt-3">
            <span className="text-muted-foreground">
              {t('nextCharge', { date: fmtDay(account.nextCharge.date, locale) })}
            </span>
            <span className="font-medium tabular-nums">
              {eur(account.nextCharge.amount, locale)}
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          {account.automatic && payLabel ? (
            <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-4" /> {t('automatic', { method: payLabel })}
            </span>
          ) : (
            <>
              <span className="text-muted-foreground">
                {payLabel ? t('savedNotAutomatic', { method: payLabel }) : t('manual')}
              </span>
              {account.canSetupAutomatic && !payLabel && (
                <Button size="sm" variant="outline" onClick={() => onNavigate('facturas')}>
                  <CreditCard className="mr-1 size-4" /> {t('setupAutomatic')}
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
