import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AccessModule } from '../access/access.module';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { ContractsModule } from '../contracts/contracts.module';
import { CustomerMessagesModule } from '../customer-messages/customer-messages.module';
import { CustomerDocumentsService } from '../customers/customer-documents.service';
import { FaqModule } from '../faq/faq.module';
import { MoveInModule } from '../move-in/move-in.module';
import { OperationsModule } from '../operations/operations.module';
import { GoCardlessModule } from '../payments/gocardless/gocardless.module';
import { PaymentsModule } from '../payments/payments.module';
import { RedsysModule } from '../payments/redsys/redsys.module';
import { ProductsModule } from '../products/products.module';
import { PushModule } from '../push/push.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { RetentionModule } from '../retention/retention.module';
import { UnitChangesModule } from '../unit-changes/unit-changes.module';
import { UnitRequestsModule } from '../unit-requests/unit-requests.module';

import { NightPassService } from './night-pass.service';
import { PortalLinkController } from './portal-link.controller';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

@Module({
  // PaymentsModule: self-service de metodos de pago + cobro desde el portal.
  // RedsysModule: pago de facturas por TPV bancario (redirect) desde el portal.
  // AccessModule: el inquilino ve/regenera su credencial QR/PIN.
  // ReferralsModule: el inquilino ve su código de referido + sus referidos.
  imports: [
    AuthModule,
    RetentionModule,
    JwtModule.register({}),
    PaymentsModule,
    RedsysModule,
    GoCardlessModule,
    AccessModule,
    // BillingModule: factura del pase nocturno (InvoicesService + serie).
    BillingModule,
    ReferralsModule,
    // ContractsModule: el inquilino ve sus contratos y solicita la baja (move-out).
    ContractsModule,
    // OperationsModule: el inquilino reporta incidencias desde el portal.
    OperationsModule,
    // PushModule: suscripción a notificaciones push desde el portal.
    PushModule,
    // UnitChangesModule: el inquilino solicita cambio de trastero.
    UnitChangesModule,
    // UnitRequestsModule: el inquilino solicita un trastero adicional.
    UnitRequestsModule,
    // MoveInModule: self-service de contratación de trastero (SignaturesService).
    MoveInModule,
    // ProductsModule: tienda de accesorios (compra → venta + factura).
    ProductsModule,
    // CustomerMessagesModule: chat bidireccional con el staff.
    CustomerMessagesModule,
    // FaqModule: centro de ayuda (preguntas frecuentes).
    FaqModule,
    AiModule,
  ],
  controllers: [PortalController, PortalLinkController],
  // CustomerDocumentsService se PROVEE aquí (sus deps —Prisma/Files globales,
  // AuditService de AuthModule— ya están disponibles) en vez de importar
  // CustomersModule entero: importarlo reintroducía el JwtModule de AuthModule
  // y rompía la verificación del token del portal (401 en /portal/me/*).
  providers: [PortalService, NightPassService, CustomerDocumentsService],
})
export class PortalModule {}
