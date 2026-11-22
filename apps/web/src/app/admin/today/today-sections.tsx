'use client';

import {
  PLATFORM_LEAD_SOURCE_LABELS,
  pluralEs,
  TICKET_URGENT_HOURS,
  isTicketUrgent,
  type AdminOpenTicketDto,
  type AdminTodayFailedJobDto,
  type AdminTodayInactiveDto,
  type AdminTodayLeadDto,
  type AdminTodayPaymentFailureDto,
  type SupportTicketPriorityValue,
} from '@storageos/shared';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { TenantEmailDialog } from '../tenants/[id]/tenant-email-dialog';

import { reportBatch } from './today-batch-bar';
import { ReappearedBadge, Row, RowShell, SimpleCard, SnoozeMenu, TenantRow } from './today-rows';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAdminAuthStore } from '@/lib/admin/auth-store';
import {
  useAddAdminTicketMessage,
  useAssignTicket,
  useCreateFollowup,
  useRemindReceivable,
  useTodayFailedJobs,
} from '@/lib/admin/hooks';
import { useSendLeadEmail, useUpdateLead } from '@/lib/admin/leads-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

export const eur = (n: number, c = 'EUR') =>
  n.toLocaleString('es-ES', { style: 'currency', currency: c || 'EUR' });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('es-ES');
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
const errorText = (err: unknown) => (err instanceof ApiError ? err.body.message : 'Error');

/** «3 h», «2 d» (horas positivas). */
function hoursText(hours: number): string {
  const h = Math.abs(hours);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

/** «hace 3 h» desde una fecha. */
function ago(iso: string): string {
  return `hace ${hoursText((Date.now() - new Date(iso).getTime()) / 3_600_000)}`;
}

const PRIORITY_LABELS: Record<SupportTicketPriorityValue, string> = {
  urgent: 'urgente',
  high: 'alta',
  normal: 'normal',
  low: 'baja',
};

/** Plazo de respuesta de cada prioridad (cabecera de los tickets). */
export function ResponseTargets({
  targets,
}: {
  targets: Record<SupportTicketPriorityValue, number>;
}) {
  const order: SupportTicketPriorityValue[] = ['urgent', 'high', 'normal', 'low'];
  return (
    <>
      Plazo de respuesta:{' '}
      {order.map((p) => `${PRIORITY_LABELS[p]} ${hoursText(targets[p])}`).join(' · ')}. Son urgentes
      los de prioridad urgente y los que vencen en menos de {TICKET_URGENT_HOURS} h o ya están fuera
      de plazo.
    </>
  );
}

/** «Vence en 3 h» / «Fuera de plazo hace 2 h». */
function DueLabel({ ticket }: { ticket: AdminOpenTicketDto }) {
  const late = ticket.dueInHours < 0;
  const soon = !late && ticket.dueInHours < TICKET_URGENT_HOURS;
  return (
    <span
      className={`text-xs ${late ? 'font-medium text-red-600 dark:text-red-400' : soon ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
      title={`Plazo de ${hoursText(ticket.responseTargetHours)} desde el último mensaje del cliente (${fmtDateTime(ticket.lastTenantMessageAt)})`}
    >
      {late
        ? `Fuera de plazo hace ${hoursText(ticket.dueInHours)}`
        : `Vence en ${hoursText(ticket.dueInHours)}`}
    </span>
  );
}

export function TicketRow({ ticket: t }: { ticket: AdminOpenTicketDto }) {
  const me = useAdminAuthStore((s) => s.superAdmin?.id);
  const assign = useAssignTicket();
  const reply = useAddAdminTicketMessage();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');

  function send() {
    reply.mutate(
      { id: t.id, input: { body: body.trim(), isInternal: false } },
      {
        onSuccess: () => {
          toast.success('Respuesta enviada.');
          setBody('');
          setOpen(false);
        },
        onError: (err) => toast.error(errorText(err)),
      },
    );
  }

  return (
    <RowShell
      snooze={{ kind: 'ticket', ref: t.id, label: t.subject }}
      assign={{ kind: 'ticket', ref: t.id }}
      urgent={isTicketUrgent(t)}
      className="space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/admin/support/${t.id}`}
            data-row-link=""
            className="font-medium hover:underline"
          >
            {t.subject}
          </Link>
          <span className="text-muted-foreground"> · </span>
          <Link
            href={`/admin/tenants/${t.tenantId}`}
            className="text-muted-foreground hover:underline"
          >
            {t.tenantName}
          </Link>
          {t.monthly ? (
            <span className="text-xs text-muted-foreground"> · {eur(t.monthly)}/mes sin IVA</span>
          ) : null}
          {(t.priority === 'urgent' || t.priority === 'high') && (
            <span className="ml-1 text-xs font-medium text-red-500">
              {PRIORITY_LABELS[t.priority]}
            </span>
          )}
          {t.assignedAdminName && (
            <span className="ml-1 text-xs text-muted-foreground">· {t.assignedAdminName}</span>
          )}
          <ReappearedBadge reason={t.reappearedReason} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <DueLabel ticket={t} />
          {me && t.assignedAdminId !== me && (
            <Button
              size="sm"
              variant="ghost"
              disabled={assign.isPending}
              onClick={() => assign.mutate({ id: t.id, input: { superAdminId: me } })}
            >
              Asignarme
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            Responder
          </Button>
          <SnoozeMenu kind="ticket" refId={t.id} label={t.subject} />
        </div>
      </div>
      {open && (
        <div className="space-y-2">
          <Textarea
            aria-label="Respuesta"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <Button size="sm" disabled={reply.isPending || !body.trim()} onClick={send}>
            Enviar
          </Button>
        </div>
      )}
    </RowShell>
  );
}

/** Correo a un lead desde «Hoy» (como «Escribir» en su ficha). */
function LeadReplyDialog({
  lead,
  open,
  onClose,
}: {
  lead: AdminTodayLeadDto;
  open: boolean;
  onClose: () => void;
}) {
  const send = useSendLeadEmail();
  const [subject, setSubject] = useState('Tu consulta sobre TrasterOS');
  const [body, setBody] = useState('');
  function submit() {
    send.mutate(
      { id: lead.id, input: { subject: subject.trim(), body: body.trim() } },
      {
        onSuccess: () => {
          toast.success('Correo enviado.');
          setBody('');
          onClose();
        },
        onError: (err) => toast.error(errorText(err)),
      },
    );
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Responder a {lead.name}</DialogTitle>
          <DialogDescription>Se envía a {lead.email} y queda en su ficha.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`lead-subject-${lead.id}`}>Asunto</Label>
            <Input
              id={`lead-subject-${lead.id}`}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`lead-body-${lead.id}`}>Mensaje</Label>
            <Textarea
              id={`lead-body-${lead.id}`}
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={send.isPending || subject.trim().length < 3 || !body.trim()}
            onClick={submit}
          >
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LeadRow({ lead: c, urgent }: { lead: AdminTodayLeadDto; urgent: boolean }) {
  const me = useAdminAuthStore((s) => s.superAdmin?.id);
  const update = useUpdateLead();
  const [replying, setReplying] = useState(false);
  return (
    <>
      <Row
        title={
          <Link
            href={`/admin/leads?lead=${c.id}`}
            data-row-link=""
            className="font-medium hover:underline"
          >
            {c.name}
          </Link>
        }
        detail={`${PLATFORM_LEAD_SOURCE_LABELS[c.source] ?? c.source} · ${
          c.waitingHours < 24
            ? `hace ${c.waitingHours} h`
            : `hace ${Math.floor(c.waitingHours / 24)} d`
        }${c.assignedToName ? ` · ${c.assignedToName}` : ''}`}
        snooze={{ kind: 'contact', ref: c.id, label: c.name }}
        assign={{ kind: 'contact', ref: c.id }}
        urgent={urgent}
        actions={
          <>
            {me && c.assignedToId !== me && (
              <Button
                size="sm"
                variant="ghost"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate(
                    { id: c.id, input: { assignedToId: me } },
                    {
                      onSuccess: () => toast.success('Lead asignado a ti.'),
                      onError: (err) => toast.error(errorText(err)),
                    },
                  )
                }
              >
                Asignarme
              </Button>
            )}
            {c.email ? (
              <Button size="sm" variant="outline" onClick={() => setReplying(true)}>
                Responder
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href={`/admin/leads?lead=${c.id}`}>Responder</Link>
              </Button>
            )}
          </>
        }
      />
      {replying && <LeadReplyDialog lead={c} open={replying} onClose={() => setReplying(false)} />}
    </>
  );
}

const SOURCE_LABELS: Record<AdminTodayPaymentFailureDto['source'], string> = {
  stripe: 'Stripe',
  redsys: 'Tarjeta (Redsys)',
  sepa: 'Domiciliación SEPA',
  other: 'Cobro',
};

export function PaymentFailureRow({ failure: f }: { failure: AdminTodayPaymentFailureDto }) {
  const remind = useRemindReceivable();
  const canRemind = useIsSuperadmin();
  return (
    <TenantRow
      id={f.tenantId}
      name={f.tenantName}
      urgent
      detail={[
        SOURCE_LABELS[f.source],
        eur(f.amount, f.currency),
        f.reason,
        f.failures > 1 ? `${f.failures} rechazos` : null,
        ago(f.failedAt),
      ]
        .filter(Boolean)
        .join(' · ')}
      snooze={{ kind: 'payment_failure', ref: f.tenantId, label: f.tenantName }}
      notice={f.reappearedReason}
      actions={
        <>
          {canRemind && f.pastDue && (
            <Button
              size="sm"
              variant="outline"
              disabled={remind.isPending}
              onClick={() =>
                remind.mutate(f.tenantId, {
                  onSuccess: () => toast.success('Recordatorio enviado.'),
                  onError: (err) => toast.error(errorText(err)),
                })
              }
            >
              Recordar el pago
            </Button>
          )}
          <Button asChild size="sm" variant="ghost">
            <Link href={`/admin/tenants/${f.tenantId}?tab=payments`}>Ver cobros</Link>
          </Button>
        </>
      }
    />
  );
}

/** Seguimiento para mañana a quien lo crea: «Llamar: han dejado de entrar». */
function tomorrowIso(): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function InactiveRow({ tenant: t }: { tenant: AdminTodayInactiveDto }) {
  const me = useAdminAuthStore((s) => s.superAdmin?.id);
  const followup = useCreateFollowup(t.tenantId);
  const [writing, setWriting] = useState(false);
  return (
    <>
      <TenantRow
        id={t.tenantId}
        name={t.tenantName}
        detail={[
          t.planName,
          `${eur(t.monthly)}/mes sin IVA`,
          t.lastLoginAt
            ? `sin entrar desde el ${fmtDate(t.lastLoginAt)} (${t.daysSinceLogin} d)`
            : 'nadie ha entrado nunca',
        ]
          .filter(Boolean)
          .join(' · ')}
        snooze={{ kind: 'inactive', ref: t.tenantId, label: t.tenantName }}
        notice={t.reappearedReason}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setWriting(true)}>
              Escribir
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={followup.isPending}
              onClick={() =>
                followup.mutate(
                  {
                    title: 'Llamar: han dejado de entrar',
                    dueDate: tomorrowIso(),
                    ...(me ? { assignedToId: me } : {}),
                  },
                  {
                    onSuccess: () => toast.success('Seguimiento creado para mañana.'),
                    onError: (err) => toast.error(errorText(err)),
                  },
                )
              }
            >
              Seguimiento
            </Button>
          </>
        }
      />
      {writing && (
        <TenantEmailDialog tenantId={t.tenantId} open={writing} onClose={() => setWriting(false)} />
      )}
    </>
  );
}

/** Fallidos de las colas de las últimas 24 h, con reintentar y marcar revisado. */
export function FailedJobsCard({ total, jobs }: { total: number; jobs: AdminTodayFailedJobDto[] }) {
  const canAct = useIsSuperadmin();
  const retry = useTodayFailedJobs('retry');
  const review = useTodayFailedJobs('review');
  const busy = retry.isPending || review.isPending;
  const ref = (j: AdminTodayFailedJobDto) => ({ queue: j.queue, id: j.id });

  function act(kind: 'retry' | 'review', list: AdminTodayFailedJobDto[]) {
    const mutation = kind === 'retry' ? retry : review;
    mutation.mutate(
      { jobs: list.map(ref) },
      {
        onSuccess: (result) =>
          reportBatch(kind === 'retry' ? 'Reintentados' : 'Marcados como revisados', result),
        onError: (err) => toast.error(errorText(err)),
      },
    );
  }

  return (
    <SimpleCard
      title={`Colas con fallos (${total})`}
      icon={<AlertTriangle className="size-4 text-red-500" />}
      action={{ href: '/admin/queues', label: 'Ver Sistema y colas →' }}
      description={
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {pluralEs(total, 'trabajo fallido', 'trabajos fallidos')} en las últimas 24 h
            {total > jobs.length ? ` (se ven los ${jobs.length} más recientes)` : ''}.
          </span>
          {canAct && jobs.length > 1 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act('retry', jobs)}>
              Reintentar todos
            </Button>
          )}
        </span>
      }
    >
      {jobs.map((j) => (
        <Row
          key={`${j.queue}:${j.id}`}
          urgent
          title={
            <span className="min-w-0">
              <span className="font-mono text-xs">{j.queue}</span>
              <span className="text-muted-foreground"> · </span>
              <span className="font-medium">{j.name}</span>
              {j.reason && (
                <span className="block max-w-xl truncate text-xs text-muted-foreground">
                  {j.reason}
                </span>
              )}
            </span>
          }
          detail={`${ago(j.failedAt)}${j.attempts > 1 ? ` · ${j.attempts} intentos` : ''}`}
          actions={
            canAct && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => act('retry', [j])}
                >
                  Reintentar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => act('review', [j])}
                >
                  Marcar revisado
                </Button>
              </>
            )
          }
        />
      ))}
    </SimpleCard>
  );
}
