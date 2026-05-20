import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';

import { ProductSalesController } from './product-sales.controller';
import { ProductSalesService } from './product-sales.service';
import { ProductStockController } from './product-stock.controller';
import { ProductStockService } from './product-stock.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [ProductsController, ProductStockController, ProductSalesController],
  providers: [ProductsService, ProductStockService, ProductSalesService],
})
export class ProductsModule {}
