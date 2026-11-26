import { SEO_CRAWLER_ROBOTS_TOKEN, SEO_CRAWLER_USER_AGENT } from '@storageos/shared';
import Link from 'next/link';

import type { Metadata } from 'next';

export const metadata: Metadata = {
  alternates: { canonical: '/rastreador' },
  title: 'Rastreador SEO de TrasterOS',
  description:
    'Qué es el rastreador TrasterOS-SEO-Crawler, qué páginas visita y cómo pararlo desde robots.txt.',
};

/**
 * La página que enlaza el agente de usuario del rastreador SEO (PR 10): quien
 * vea sus visitas en los registros de su servidor sabe qué es y cómo pararlo.
 */
export default function CrawlerPage() {
  return (
    <div className="container max-w-3xl space-y-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Rastreador SEO de TrasterOS</h1>
      <p>
        Si ves visitas con este agente de usuario en los registros de tu servidor, son nuestras:
      </p>
      <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-sm">
        {SEO_CRAWLER_USER_AGENT}
      </pre>
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Qué hace</h2>
        <p>
          Revisa el SEO técnico de las webs de los negocios que usan TrasterOS (errores, títulos,
          enlaces rotos, canónicas, mapa del sitio…). Solo visita las webs que sus dueños han
          añadido a su proyecto, pide las páginas de una en una con una pausa entre ellas, respeta
          robots.txt y no envía formularios ni ejecuta nada.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Cómo pararlo</h2>
        <p>Añade estas líneas a tu robots.txt:</p>
        <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-sm">
          {`User-agent: ${SEO_CRAWLER_ROBOTS_TOKEN}\nDisallow: /`}
        </pre>
        <p>
          Si crees que está visitando tu web por error, escríbenos a través de{' '}
          <Link href="/#contacto" className="underline">
            nuestra página de contacto
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
