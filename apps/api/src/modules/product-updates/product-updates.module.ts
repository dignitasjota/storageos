import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';

import {
  AdminProductUpdatesController,
  ProductUpdatesController,
} from './product-updates.controller';
import { ProductUpdatesService } from './product-updates.service';

/** «Novedades» de la plataforma (las publica el super admin, las leen los tenants). */
@Module({
  imports: [JwtModule.register({})],
  controllers: [ProductUpdatesController, AdminProductUpdatesController],
  providers: [ProductUpdatesService, AdminGuard],
})
export class ProductUpdatesModule {}
