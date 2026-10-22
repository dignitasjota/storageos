import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Cómo funciona' };

type Topic = {
  title: string;
  steps: string[];
  links: { label: string; href: string }[];
};

/** Guía corta del día a día con TrasterOS (qué pasa solo y qué haces tú). */
const TOPICS: Topic[] = [
  {
    title: 'Alquilar un trastero',
    steps: [
      'El cliente reserva en tu web (o lo das de alta tú en el panel con «Nuevo contrato»).',
      'Firma el contrato desde el móvil o en el local, en tu tablet.',
      'Paga la primera factura (alquiler y fianza) y recibe solo su código de acceso.',
    ],
    links: [
      { label: 'Nuevo contrato', href: '/contracts/new' },
      { label: 'Reservas', href: '/reservations' },
    ],
  },
  {
    title: 'Cobrar cada mes',
    steps: [
      'Cada mes se preparan las facturas de los contratos activos (en borrador o emitidas, según tus ajustes).',
      'Si el inquilino tiene tarjeta o domiciliación y el cobro automático está activo, se cobran solas; si falla, se reintenta.',
      'Si cobras por remesa SEPA, la generas en Cobros por banco y subes el fichero a tu banco.',
    ],
    links: [
      { label: 'Facturas', href: '/invoices' },
      { label: 'Cobros del mes', href: '/collections-month' },
      { label: 'Ajustes de cobro', href: '/settings/payments' },
    ],
  },
  {
    title: 'Si alguien no paga',
    steps: [
      'Al vencer una factura, el inquilino recibe un recordatorio y, a la semana, un segundo aviso.',
      'Según tus ajustes se añade un recargo y, más adelante, se suspende su código de acceso.',
      'Al pagar, el acceso vuelve solo. Puedes ofrecer un plan de pagos desde Deudores.',
    ],
    links: [
      { label: 'Deudores', href: '/arrears' },
      { label: 'Hoy', href: '/today' },
    ],
  },
  {
    title: 'Bajas y fianzas',
    steps: [
      'El inquilino pide la baja desde su área de clientes con el preaviso de su contrato.',
      'Llegada la fecha, el contrato termina solo (puedes desactivarlo) y el trastero queda libre.',
      'Desde la ficha del contrato liquidas la fianza: la devuelves entera o retienes lo que corresponda.',
    ],
    links: [{ label: 'Contratos', href: '/contracts' }],
  },
  {
    title: 'Tu web y los nuevos clientes',
    steps: [
      'Tu web pública muestra tus locales, tamaños y precios, y permite reservar online.',
      'Los formularios y reservas a medias quedan como contactos para que les escribas.',
      'Con enlaces por canal (Instagram, un flyer, Google Ads) sabes de dónde llega cada cliente.',
    ],
    links: [
      { label: 'Contactos', href: '/leads' },
      { label: 'Tu web', href: '/settings/web' },
      { label: 'Resumen de marketing', href: '/marketing/summary' },
    ],
  },
  {
    title: 'El área de clientes',
    steps: [
      'Cada inquilino ve sus contratos, facturas y código de acceso, y puede pagar y escribirte.',
      'Le llega el acceso por correo al darlo de alta; también puedes copiar un enlace desde su ficha.',
    ],
    links: [{ label: 'Inquilinos', href: '/customers' }],
  },
];

export default function HelpPage() {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cómo funciona</h1>
        <p className="text-sm text-muted-foreground">
          El día a día con TrasterOS: qué pasa solo y qué haces tú. Para empezar, revisa la{' '}
          <Link href="/settings/getting-started" className="text-primary hover:underline">
            puesta en marcha
          </Link>
          ; si algo no queda claro,{' '}
          <Link href="/support" className="text-primary hover:underline">
            escríbenos
          </Link>
          .
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {TOPICS.map((topic) => (
          <Card key={topic.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{topic.title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                {topic.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {topic.links.map((l) => (
                  <Link key={l.href} href={l.href} className="text-primary hover:underline">
                    {l.label}
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
