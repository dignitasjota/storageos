import { CheckCircle2 } from 'lucide-react';

import { PortalReturnLink } from '@/components/public/portal-return-link';
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
            {brand && (
              <PortalReturnLink
                tenantSlug={brand.tenantSlug}
                className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-md px-4 text-sm font-medium text-white"
                style={{ backgroundColor: brand.brandColor ?? '#2563EB' }}
              >
                Volver a mis facturas
              </PortalReturnLink>
            )}
          </CardContent>
        </Card>
      </div>
    </TenantMiniChrome>
  );
}
