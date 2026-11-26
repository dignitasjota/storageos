import { seoAlertSettingsOf, seoReportSettingsOf } from '@storageos/shared';

import { tenantHasFeature } from '../../common/tenant-features';

import type { PrismaAdminService } from '../database/prisma-admin.service';

/**
 * Con SEO Avanzado (que incluye SEO local) y su proyecto creado, su informe
 * mensual y su alerta de caída de clics sustituyen a los de SEO local: así no
 * llegan dos informes ni dos avisos de lo mismo. Si el tenant apaga el informe
 * mensual (o la alerta) del proyecto, vuelve a recibir los de SEO local.
 */
export async function seoAdvancedReplaces(
  admin: PrismaAdminService,
  tenantId: string,
  what: 'monthly_report' | 'clicks_drop',
): Promise<boolean> {
  const project = await admin.seoProject.findFirst({
    where: { tenantId, status: 'active' },
    select: { reportSettings: true, alertSettings: true },
  });
  if (!project) return false;
  if (!(await tenantHasFeature(admin, tenantId, 'seo_advanced'))) return false;
  return what === 'monthly_report'
    ? seoReportSettingsOf(project.reportSettings).monthly
    : !seoAlertSettingsOf(project.alertSettings).disabled.includes('clicks_drop');
}
