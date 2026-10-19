'use client';

import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { FirstPaymentMonths, LeadDto, LeadQuoteDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useLeadQuotePreview, useSendLeadQuote } from '@/lib/communications/hooks';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { useInsurancePlans } from '@/lib/insurance/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const NONE = 'none';

/**
 * Presupuesto al contacto: local, tamaño, meses del primer pago, cupón y
 * seguro → lo que pagaría con IVA y un correo con el enlace a la reserva ya
 * rellenada. Si reserva, la reserva queda atribuida al contacto.
 */
export function LeadQuote({ lead }: { lead: LeadDto }) {
  const canSend = useHasPermission('communications:send');
  const hasInsurance = useHasFeature('insurance');
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const plans = useInsurancePlans(true);
  const preview = useLeadQuotePreview(lead.id);
  const send = useSendLeadQuote(lead.id);
  const [open, setOpen] = useState(false);
  const [facilityId, setFacilityId] = useState(lead.preferredFacilityId ?? '');
  const [unitTypeId, setUnitTypeId] = useState(lead.preferredUnitTypeId ?? '');
  const [months, setMonths] = useState<FirstPaymentMonths>(1);
  const [coupon, setCoupon] = useState('');
  const [planId, setPlanId] = useState(NONE);
  const [result, setResult] = useState<LeadQuoteDto | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    if (!facilityId && facilities.data?.length === 1) setFacilityId(facilities.data[0]!.id);
  }, [facilities.data, facilityId]);

  const input = {
    facilityId,
    unitTypeId,
    months,
    ...(coupon.trim() ? { couponCode: coupon.trim() } : {}),
    ...(planId !== NONE ? { insurancePlanId: planId } : {}),
  };

  async function calculate() {
    try {
      const r = await preview.mutateAsync(input);
      setResult(r);
      setSubject(r.subject);
      setBody(r.body);
    } catch (err) {
      setResult(null);
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo calcular.');
    }
  }

  async function submit() {
    try {
      const r = await send.mutateAsync({ ...input, subject, body });
      toast.success(`Presupuesto enviado a ${r.sentTo}.`);
      setOpen(false);
      setResult(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  if (!canSend) return null;
  if (!open) {
    return (
      <div className="border-t pt-3">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <FileText className="mr-1 size-4" /> Preparar presupuesto
        </Button>
        {!lead.email && (
          <span className="ml-2 text-xs text-muted-foreground">
            Sin email: podrás calcularlo pero no enviarlo.
          </span>
        )}
      </div>
    );
  }

  const q = result?.quote;
  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-sm font-medium">Presupuesto</p>
      <div className="grid grid-cols-2 gap-2">
        <Select value={facilityId} onValueChange={(v) => setFacilityId(v)}>
          <SelectTrigger aria-label="Local">
            <SelectValue placeholder="Local" />
          </SelectTrigger>
          <SelectContent>
            {(facilities.data ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={unitTypeId} onValueChange={(v) => setUnitTypeId(v)}>
          <SelectTrigger aria-label="Tamaño">
            <SelectValue placeholder="Tamaño" />
          </SelectTrigger>
          <SelectContent>
            {(unitTypes.data ?? []).map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(months)}
          onValueChange={(v) => setMonths(Number(v) as FirstPaymentMonths)}
        >
          <SelectTrigger aria-label="Meses del primer pago">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 3, 6, 12].map((m) => (
              <SelectItem key={m} value={String(m)}>
                {m === 1 ? 'Pago mensual' : `Primer pago de ${m} meses`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Cupón (opcional)"
          value={coupon}
          onChange={(e) => setCoupon(e.target.value.toUpperCase())}
          aria-label="Cupón"
        />
        {hasInsurance && (plans.data?.length ?? 0) > 0 && (
          <Select value={planId} onValueChange={setPlanId}>
            <SelectTrigger aria-label="Seguro" className="col-span-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Sin protección de contenido</SelectItem>
              {(plans.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!facilityId || !unitTypeId || preview.isPending}
          onClick={() => void calculate()}
        >
          Calcular
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cerrar
        </Button>
      </div>

      {q && result && (
        <>
          <div className="space-y-1 rounded-md border p-3 text-sm">
            <p className="font-medium">
              {result.unitTypeName}
              {result.areaM2 ? ` (${result.areaM2} m²)` : ''} · {result.facilityName}
            </p>
            <p>
              Alquiler {q.months > 1 ? `de ${q.months} meses` : 'del primer mes'}:{' '}
              <span className="tabular-nums">{eur(q.rentTotalWithVat)}</span> (IVA incl.)
              {q.freeMonths > 0 && ` · ${q.freeMonths} gratis`}
            </p>
            {q.insuranceWithVat > 0 && (
              <p>
                {result.insuranceName}:{' '}
                <span className="tabular-nums">{eur(q.insuranceWithVat)}</span>
              </p>
            )}
            {q.deposit > 0 && (
              <p>
                Fianza: <span className="tabular-nums">{eur(q.deposit)}</span>
              </p>
            )}
            <p className="font-medium">
              Total al reservar: <span className="tabular-nums">{eur(q.totalToPay)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Después {eur(result.monthlyWithVat)}/mes (IVA incl.).
              {q.prorated && ' El primer mes se prorratea si entra a mitad de mes.'}
            </p>
            {q.coupon && !q.coupon.valid && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Cupón no aplicado: {q.coupon.message}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="quote-subject">Asunto</Label>
            <Input
              id="quote-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="quote-body">Mensaje</Label>
            <Textarea
              id="quote-body"
              rows={9}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!lead.email || send.isPending}
              onClick={() => void submit()}
            >
              Enviar presupuesto
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(result.bookUrl);
                toast.success('Enlace de reserva copiado.');
              }}
            >
              Copiar enlace de reserva
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
