'use client';

import { Hourglass, Loader2, ScrollText } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import type { LeadDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useConvertLead } from '@/lib/communications/hooks';
import { useCreateWaitlistEntry } from '@/lib/waitlist/hooks';

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;

/**
 * Lo que suele venir después: hacerle el contrato (pasa a inquilino y abre el
 * asistente con el local y el tamaño que busca) o, si no hay sitio, apuntarle
 * a la lista de espera de ese tamaño.
 */
export function LeadNextStep({ lead, onDone }: { lead: LeadDto; onDone: () => void }) {
  const ask = useConfirm();
  const router = useRouter();
  const canContract = useHasPermission('contracts:write');
  const canWaitlist = useHasPermission('reservations:write');
  const convert = useConvertLead();
  const waitlist = useCreateWaitlistEntry();
  const open = lead.status !== 'won' && lead.status !== 'lost';

  if (!open && !lead.convertedCustomerId) return null;

  const contractUrl = (customerId: string) => {
    const q = new URLSearchParams({ customerId });
    if (lead.preferredFacilityId) q.set('facilityId', lead.preferredFacilityId);
    if (lead.preferredUnitTypeId) q.set('unitTypeId', lead.preferredUnitTypeId);
    return `/contracts/new?${q.toString()}`;
  };

  const createContract = async () => {
    if (lead.convertedCustomerId) {
      router.push(contractUrl(lead.convertedCustomerId));
      return;
    }
    if (
      !(await ask({
        title: 'Hacerle el contrato',
        description: `«${lead.displayName}» pasa a ser inquilino (si ya hay uno con su email, se enlaza con él) y se abre el asistente del contrato.`,
        confirmLabel: 'Continuar',
      }))
    ) {
      return;
    }
    try {
      const r = await convert.mutateAsync({ id: lead.id, input: {} });
      if (r.convertedCustomerId) {
        onDone();
        router.push(contractUrl(r.convertedCustomerId));
      }
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido convertir'));
    }
  };

  const toWaitlist = () => {
    if (!lead.preferredFacilityId || !lead.preferredUnitTypeId || !lead.email) return;
    waitlist.mutate(
      {
        facilityId: lead.preferredFacilityId,
        unitTypeId: lead.preferredUnitTypeId,
        contactName: lead.displayName,
        contactEmail: lead.email,
        ...(lead.phone ? { contactPhone: lead.phone } : {}),
        notes: 'Desde Leads',
      },
      {
        onSuccess: () => toast.success('Apuntado a la lista de espera de ese tamaño.'),
        onError: (err) => toast.error(errorText(err, 'No se ha podido apuntar')),
      },
    );
  };

  const waitlistReady = !!(lead.preferredFacilityId && lead.preferredUnitTypeId && lead.email);
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-3">
      {canContract && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={convert.isPending}
          onClick={() => void createContract()}
        >
          {convert.isPending ? (
            <Loader2 className="mr-1 size-4 animate-spin" />
          ) : (
            <ScrollText className="mr-1 size-4" />
          )}
          Hacerle el contrato
        </Button>
      )}
      {canWaitlist && open && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!waitlistReady || waitlist.isPending}
          title={
            waitlistReady
              ? 'Le avisaremos cuando quede libre un trastero de ese tamaño'
              : 'Indica el local, el tamaño que busca y su email'
          }
          onClick={toWaitlist}
        >
          <Hourglass className="mr-1 size-4" /> Lista de espera
        </Button>
      )}
      {canWaitlist && open && !waitlistReady && (
        <span className="text-xs text-muted-foreground">
          Para la lista de espera: local, tamaño y email.
        </span>
      )}
    </div>
  );
}
