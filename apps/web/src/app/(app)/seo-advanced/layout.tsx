import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';

/** Extra «SEO Avanzado» (incluye lo de «SEO local»). */
export default function SeoAdvancedLayout({ children }: { children: ReactNode }) {
  return (
    <FeatureGate
      feature="seo_advanced"
      pitch={
        <div className="space-y-2">
          <p>Todo lo que dice Google de tu web, con el detalle que su panel no te deja cruzar:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Por qué búsquedas, páginas, países y dispositivos te encuentran, día a día.</li>
            <li>Hasta 16 meses de historia, guardados aunque Google los borre después.</li>
            <li>Tu dominio principal y hasta tres más (por ejemplo, el antiguo).</li>
            <li>Incluye todo lo de SEO local: páginas de zona, revisión y posiciones.</li>
          </ul>
          <p>Es un extra aparte; puedes contratarlo desde tu suscripción.</p>
        </div>
      }
    >
      {children}
    </FeatureGate>
  );
}
