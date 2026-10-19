'use client';

import {
  OPPORTUNITY_LABELS,
  type OpportunityDto,
  type OpportunityKind,
  OpportunityKindEnum,
} from '@storageos/shared';
import { MessageCircle, Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useOpportunities,
  useOpportunityDraft,
  useProposeOpportunity,
} from '@/lib/opportunities/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES');

/** Teléfono español en formato internacional para wa.me. */
function waNumber(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 9) return `34${digits}`;
  return digits.length >= 10 ? digits : null;
}

/**
 * Oportunidades: a quién ofrecer qué (seguro, trastero mayor, otro trastero,
 * pase nocturno, domiciliar) y por qué. El sistema redacta la propuesta; nada
 * se contrata ni se cambia hasta que el inquilino lo hace.
 */
export default function OpportunitiesPage() {
  const opps = useOpportunities();
  const [kind, setKind] = useState<OpportunityKind | 'all'>('all');
  const [open, setOpen] = useState<OpportunityDto | null>(null);
  const canSend = useHasPermission('communications:send');
  const d = opps.data;
  const rows = (d?.items ?? []).filter((i) => kind === 'all' || i.kind === kind);
  const total = d ? Object.values(d.byKind).reduce((s, k) => s + k.monthlyValue, 0) : 0;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Oportunidades</h1>
        <p className="text-sm text-muted-foreground">
          Qué ofrecer a cada inquilino según lo que tiene y lo que mira en su área de clientes.
          {total > 0 && (
            <>
              {' '}
              Potencial: <span className="font-medium text-foreground">{eur(total)}/mes</span> sin
              IVA.
            </>
          )}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setKind('all')}
          className={`h-9 rounded-md border px-3 text-sm ${kind === 'all' ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
        >
          Todas ({d?.items.length ?? 0})
        </button>
        {OpportunityKindEnum.options.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`h-9 rounded-md border px-3 text-sm ${kind === k ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
          >
            {OPPORTUNITY_LABELS[k]} ({d?.byKind[k].count ?? 0})
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {opps.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Cargando…</p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No hay oportunidades ahora mismo.
            </p>
          ) : (
            <ul className="divide-y">
              {rows.map((o) => (
                <li key={o.id} className="flex flex-wrap items-start gap-3 p-4">
                  <div className="min-w-[200px] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/customers/${o.customerId}`}
                        className="font-medium hover:underline"
                      >
                        {o.customerName}
                      </Link>
                      <Badge variant="secondary">{OPPORTUNITY_LABELS[o.kind]}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{o.units.join(', ')}</p>
                    <p className="mt-1 text-sm">{o.reason}</p>
                    <p className="text-sm text-muted-foreground">Ofrecer: {o.offer}</p>
                  </div>
                  <div className="w-40 text-sm">
                    {o.monthlyValue > 0 && (
                      <p className="font-medium tabular-nums">+{eur(o.monthlyValue)}/mes</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {o.lastProposedAt ? `Propuesto el ${day(o.lastProposedAt)}` : 'Sin proponer'}
                    </p>
                  </div>
                  {canSend && (
                    <Button size="sm" onClick={() => setOpen(o)}>
                      <Send className="mr-1 size-4" /> Proponer
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {open && <ProposeDialog opp={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ProposeDialog({ opp, onClose }: { opp: OpportunityDto; onClose: () => void }) {
  const draft = useOpportunityDraft(opp.customerId, opp.kind);
  const propose = useProposeOpportunity();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [followup, setFollowup] = useState(7);
  useEffect(() => {
    if (draft.data) {
      setSubject(draft.data.subject);
      setBody(draft.data.body);
    }
  }, [draft.data]);
  const wa = waNumber(opp.phone);

  async function send() {
    try {
      const res = await propose.mutateAsync({
        customerId: opp.customerId,
        kind: opp.kind,
        subject,
        body,
        followupInDays: followup,
      });
      toast.success(
        res.emailSent
          ? `Propuesta enviada a ${opp.customerName}${res.followupId ? ' y seguimiento creado' : ''}.`
          : 'Seguimiento creado (el inquilino no tiene email).',
      );
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Proponer a {opp.customerName}</DialogTitle>
          <DialogDescription>
            {OPPORTUNITY_LABELS[opp.kind]}: {opp.offer}. Es solo una propuesta: no cambia nada hasta
            que el inquilino lo contrate.
          </DialogDescription>
        </DialogHeader>
        {draft.isLoading ? (
          <p className="text-sm text-muted-foreground">Preparando el texto…</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="op-subject">Asunto</Label>
              <Input id="op-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="op-body">Mensaje</Label>
              <Textarea
                id="op-body"
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="op-followup" className="shrink-0">
                Seguimiento en
              </Label>
              <Input
                id="op-followup"
                type="number"
                min={0}
                max={60}
                className="w-20"
                value={followup}
                onChange={(e) =>
                  setFollowup(Math.max(0, Math.min(60, Number(e.target.value) || 0)))
                }
              />
              <span className="text-sm text-muted-foreground">días (0 = sin seguimiento)</span>
            </div>
            {!opp.email && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                No tiene email: solo se creará el seguimiento. Usa WhatsApp para enviarlo.
              </p>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          {wa && draft.data && (
            <Button variant="outline" asChild>
              <a
                href={`https://wa.me/${wa}?text=${encodeURIComponent(draft.data.whatsappText)}`}
                target="_blank"
                rel="noreferrer"
              >
                <MessageCircle className="mr-1 size-4" /> WhatsApp
              </a>
            </Button>
          )}
          <Button
            onClick={() => void send()}
            disabled={propose.isPending || draft.isLoading || (!opp.email && followup === 0)}
          >
            {opp.email ? 'Enviar por correo' : 'Crear seguimiento'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
