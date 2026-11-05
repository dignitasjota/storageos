import Link from 'next/link';

import { ForgotTenantForm } from './forgot-tenant-form';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: '¿Cuál es mi identificador?' };

export default function ForgotTenantPage() {
  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-md border-border/60">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">Recupera tu identificador</CardTitle>
          <CardDescription>
            Escribe tu email y te enviaremos el identificador de tu empresa.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ForgotTenantForm />
          <p className="text-center text-sm text-muted-foreground">
            <Link href="/login" className="font-medium text-primary hover:underline">
              Volver a iniciar sesión
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
