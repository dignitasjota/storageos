'use client';

import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useUpdateCustomer } from '@/lib/customers/hooks';

/**
 * Inquilino «sin fianza»: sus contratos nuevos salen con fianza 0 (panel y
 * trastero adicional desde el portal). Los contratos ya creados no cambian.
 */
export function DepositExemptCard({ customerId, exempt }: { customerId: string; exempt: boolean }) {
  const update = useUpdateCustomer();

  async function toggle() {
    try {
      await update.mutateAsync({ id: customerId, input: { depositExempt: !exempt } });
      toast.success(
        exempt
          ? 'Sus contratos nuevos volverán a llevar fianza.'
          : 'Marcado sin fianza: sus contratos nuevos no la llevarán.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Fianza</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground">
          {exempt
            ? 'Sin fianza: sus contratos nuevos salen con fianza 0. Los ya creados no cambian.'
            : 'Sus contratos llevan la fianza que corresponda al trastero.'}
        </p>
        <Can permission="customers:write">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void toggle()}
            disabled={update.isPending}
          >
            {exempt ? 'Volver a cobrar fianza' : 'Marcar sin fianza'}
          </Button>
        </Can>
      </CardContent>
    </Card>
  );
}
