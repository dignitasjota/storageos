'use client';

import { Gift } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCustomerReferralCode } from '@/lib/referrals/hooks';

/**
 * Código de referido del inquilino, para dárselo en mano o por teléfono (él lo
 * ve en su área de clientes). Solo con el programa de referidos encendido.
 */
export function ReferralCodeCard({ customerId }: { customerId: string }) {
  const canRead = useHasPermission('referrals:read');
  const code = useCustomerReferralCode(customerId, canRead);
  if (!canRead || !code.data?.enabled || !code.data.referralCode) return null;
  const value = code.data.referralCode;
  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="h-4 w-4" /> Código de referido
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground">
          Quien reserve con este código cuenta como recomendado suyo: al pagar su primera factura,
          este inquilino recibe la recompensa.
        </p>
        <div className="flex items-center gap-2">
          <span className="rounded-md border bg-muted/40 px-3 py-1.5 font-mono tracking-widest">
            {value}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(value);
              toast.success('Código copiado.');
            }}
          >
            Copiar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
