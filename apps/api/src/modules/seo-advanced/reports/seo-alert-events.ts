/**
 * Alerta nueva de un proyecto SEO de la plataforma: el panel admin la manda
 * por Telegram o Slack si están configurados (`ChatAlertsService`).
 */
export const SEO_PLATFORM_ALERT_EVENT = 'seo.platform_alert';

export interface SeoPlatformAlertEvent {
  projectId: string;
  projectName: string;
  title: string;
  message: string;
  link: string;
}
