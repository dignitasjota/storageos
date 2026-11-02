'use client';

import { fillAdminMessageVariables, renderAdminEmail } from '@storageos/shared';
import { useMemo } from 'react';

/**
 * Cómo se verá el correo (cabecera y pie de TrasterOS), con las variables de
 * un tenant de ejemplo. Iframe aislado: el HTML no toca la página.
 */
export function EmailPreviewFrame({
  subject,
  body,
  commercial = false,
  footer,
}: {
  subject: string;
  body: string;
  commercial?: boolean;
  footer?: string;
}) {
  const vars = { empresa: 'Trasteros García', nombre: 'Ana' };
  const html = useMemo(() => {
    const text = `${fillAdminMessageVariables(body || '_Sin texto_', vars)}${footer ? `\n\n—\n${footer}` : ''}`;
    return renderAdminEmail(
      text,
      commercial
        ? {
            footerHtml:
              'Recibes este correo porque usas TrasterOS. <a href="#" style="color:#64748b">Darme de baja de las novedades y ofertas</a><br>',
          }
        : {},
    ).html;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, commercial, footer]);
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="border-b bg-muted/40 px-3 py-2 text-sm">
        <span className="text-muted-foreground">Asunto: </span>
        {fillAdminMessageVariables(subject || 'Sin asunto', vars)}
      </div>
      <iframe
        title="Vista previa del correo"
        sandbox=""
        srcDoc={html}
        className="h-[460px] w-full bg-white"
      />
    </div>
  );
}
