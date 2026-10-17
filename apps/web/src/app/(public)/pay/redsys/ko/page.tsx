import { XCircle } from 'lucide-react';

import { TenantMiniChrome } from '@/components/public/tenant-mini-chrome';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchTenantBrand } from '@/lib/tenant-brand';

export default async function RedsysKoPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const brand = await fetchTenantBrand((await searchParams).t);
  return (
    <TenantMiniChrome brand={brand}>
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <XCircle className="size-5 text-destructive" /> Pago no completado
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            El pago no se ha podido procesar o se ha cancelado. No se ha realizado ningún cargo.
            Vuelve a intentarlo desde tu área de clientes o contacta con{' '}
            {brand ? brand.tenantName : 'el local'}.
          </CardContent>
        </Card>
      </div>
    </TenantMiniChrome>
  );
}
