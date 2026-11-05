'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useDeletedCustomers, useRestoreCustomer } from '@/lib/customers/features-hooks';
import { formatDate } from '@/lib/format';

/** Inquilinos borrados: se recuperan salvo los fusionados y los anonimizados. */
export default function DeletedCustomersPage() {
  const deleted = useDeletedCustomers();
  const restore = useRestoreCustomer();

  async function recover(id: string) {
    try {
      await restore.mutateAsync(id);
      toast.success('Inquilino recuperado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo recuperar.');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/customers">
          <ArrowLeft className="mr-1 h-4 w-4" /> Inquilinos
        </Link>
      </Button>
      <h1 className="text-2xl font-semibold">Inquilinos borrados</h1>
      {deleted.isError && <SectionError onRetry={() => void deleted.refetch()} />}
      {deleted.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      {deleted.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">No hay inquilinos borrados.</p>
      )}
      <div className="space-y-2">
        {(deleted.data ?? []).map((c) => (
          <Card key={c.id}>
            <CardContent className="flex items-center justify-between gap-3 p-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{c.displayName}</p>
                <p className="break-words text-muted-foreground">
                  {[c.email, `Borrado el ${formatDate(c.deletedAt)}`].filter(Boolean).join(' · ')}
                </p>
                {c.mergedInto && (
                  <p className="text-muted-foreground">
                    Fusionado en{' '}
                    <Link href={`/customers/${c.mergedInto.id}`} className="underline">
                      {c.mergedInto.displayName}
                    </Link>
                  </p>
                )}
              </div>
              {!c.mergedInto && !c.anonymized && (
                <Can permission="customers:delete">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={restore.isPending}
                    onClick={() => void recover(c.id)}
                  >
                    Recuperar
                  </Button>
                </Can>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
