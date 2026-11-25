import { buildUnsubscribeToken } from './unsubscribe-token';

/** Pie y cabeceras de baja de una comunicación comercial de TrasterOS a un usuario. */
export interface PlatformUnsubscribeFooter {
  footerHtml: string;
  footerText: string;
  headers: Record<string, string>;
}

/**
 * Enlace de baja de las novedades y ofertas de TrasterOS para un usuario del
 * equipo de un tenant (`users.platform_news_opt_out_at`), con la baja de un
 * clic (RFC 8058).
 */
export function platformUnsubscribeFooter(args: {
  key: Buffer;
  webBaseUrl: string;
  apiBaseUrl: string;
  userId: string;
}): PlatformUnsubscribeFooter {
  const token = encodeURIComponent(buildUnsubscribeToken(args.key, 'u', args.userId));
  const url = `${args.webBaseUrl}/unsubscribe/${token}`;
  const why = 'Recibes este correo porque usas TrasterOS.';
  return {
    footerHtml: `${why} <a href="${url}" style="color:#64748b">Darme de baja de las novedades y ofertas</a><br>`,
    footerText: `${why}\nDarme de baja de las novedades y ofertas: ${url}`,
    headers: {
      'List-Unsubscribe': `<${args.apiBaseUrl}/v1/public/unsubscribe/${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
