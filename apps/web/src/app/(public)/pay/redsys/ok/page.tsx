import { CheckCircle2 } from 'lucide-react';

import { TenantMiniChrome } from '@/components/public/tenant-mini-chrome';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchTenantBrand } from '@/lib/tenant-brand';

export default async function RedsysOkPage({
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
              <CheckCircle2 className="size-5 text-green-600" /> Pago recibido
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Gracias, tu pago se ha procesado correctamente. La factura se marcará como pagada en
            cuanto tu banco confirme la operación (normalmente al instante).
            {brand ? ' Puedes verla en tu área de clientes.' : ' Puedes cerrar esta ventana.'}
          </CardContent>
        </Card>
      </div>
    </TenantMiniChrome>
  );
}
