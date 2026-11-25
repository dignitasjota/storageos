import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';

import { AdminSeoController } from './admin-seo.controller';
import { SeoAdvancedController } from './seo-advanced.controller';
import { SeoAdvancedModule } from './seo-advanced.module';
import { SeoImportsService } from './seo-imports.service';
import { SeoPanelService } from './seo-panel.service';

/**
 * SEO Avanzado en el API: las rutas del tenant (`/seo-advanced`) y del panel
 * admin (`/admin/seo`), el panel con sus agregaciones y la importación de los
 * Excel históricos de Search Console.
 */
@Module({
  imports: [JwtModule.register({}), SeoAdvancedModule],
  controllers: [SeoAdvancedController, AdminSeoController],
  providers: [AdminGuard, SeoPanelService, SeoImportsService],
})
export class SeoAdvancedHttpModule {}
