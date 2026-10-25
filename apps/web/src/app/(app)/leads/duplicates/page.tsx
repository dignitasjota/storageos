'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import type { LeadDuplicateGroupDto, LeadDuplicateMemberDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { BackLink } from '@/components/layout/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { formatDate } from '@/lib/format';
import { useLeadDuplicates, useLinkLeadCustomer, useMergeLead } from '@/lib/leads/hooks';

export default function LeadDuplicatesPage() {
  const groups = useLeadDuplicates();
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <BackLink href="/leads" label="Leads" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Contactos repetidos</h1>
        <p className="text-sm text-muted-foreground">
          Contactos abiertos con el mismo email o teléfono, o que ya son inquilinos. Fusiónalos para
          no llamar dos veces a la misma persona.
        </p>
      </div>
      {groups.isLoading ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : (groups.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">No hay contactos repetidos.</p>
      ) : (
        <div className="space-y-3">
          {(groups.data ?? []).map((g) => (
            <DuplicateGroup key={`${g.reason}:${g.key}`} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}

function DuplicateGroup({ group }: { group: LeadDuplicateGroupDto }) {
  const ask = useConfirm();
  const merge = useMergeLead();
  const link = useLinkLeadCustomer();
  const canManage = useHasPermission('leads:manage');
  const canWrite = useHasPermission('leads:write');
  // Se conserva el más antiguo: es el que tiene la historia.
  const [keep, ...rest] = group.leads;

  async function mergeInto(source: LeadDuplicateMemberDto) {
    if (!keep) return;
    if (
      !(await ask({
        title: `¿Fusionar «${source.displayName}» en «${keep.displayName}»?`,
        description:
          'Se completan los datos que falten, se juntan los mensajes y se mueve su actividad. El repetido desaparece.',
      }))
    ) {
      return;
    }
    try {
      await merge.mutateAsync({ sourceId: source.id, intoLeadId: keep.id });
      toast.success('Contactos fusionados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron fusionar');
    }
  }

  async function linkToCustomer(lead: LeadDuplicateMemberDto) {
    if (!group.customer) return;
    if (
      !(await ask({
        title: `¿${lead.displayName} es ${group.customer.name}?`,
        description: 'El contacto queda enlazado al inquilino y pasa a «Ganados».',
      }))
    ) {
      return;
    }
    try {
      await link.mutateAsync({ leadId: lead.id, customerId: group.customer.id });
      toast.success('Enlazado con el inquilino.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enlazar');
    }
  }

  return (
    <Card>
      <CardContent className="space-y-2 pt-4">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">
            {group.reason === 'email' ? 'Mismo email' : 'Mismo teléfono'}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">{group.key}</span>
          {group.customer && (
            <span className="text-xs">
              · Ya es inquilino:{' '}
              <Link href={`/customers/${group.customer.id}`} className="underline">
                {group.customer.name}
              </Link>
            </span>
          )}
        </p>
        <ul className="divide-y rounded-md border">
          {group.leads.map((l, i) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
              <Link href={`/leads?lead=${l.id}`} className="font-medium hover:underline">
                {l.displayName}
              </Link>
              <span className="text-xs text-muted-foreground">
                {[l.email, l.phone].filter(Boolean).join(' · ')} · {formatDate(l.createdAt)}
              </span>
              {i === 0 && rest.length > 0 && <Badge variant="outline">Se conserva</Badge>}
              <div className="ml-auto flex gap-2">
                {group.customer && canWrite && (
                  <Button size="sm" variant="outline" onClick={() => void linkToCustomer(l)}>
                    Es este inquilino
                  </Button>
                )}
                {i > 0 && canManage && (
                  <Button size="sm" onClick={() => void mergeInto(l)}>
                    Fusionar
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
