import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type GoCardlessMandateStartDto,
  type PortalAccessCredentialDto,
  PortalConsumeMagicLinkSchema,
  PortalGoCardlessMandateCompleteSchema,
  type PaymentMethodDto,
  type PortalChargeResultDto,
  type PortalContractDto,
  type PortalDownloadDto,
  type PortalFacilityDto,
  type PortalIncidentDto,
  PortalCreateExtraAccessSchema,
  type PortalInvoiceDto,
  type PortalNightPassInfoDto,
  type PortalPaymentDto,
  type PortalProfileDto,
  PortalPurchaseSchema,
  PortalSetInsuranceSchema,
  PortalUpdateProfileSchema,
  type InsurancePlanDto,
  type ProductDto,
  type ProductSaleDto,
  type PortalReferralDto,
  PortalRegisterPaymentMethodSchema,
  PortalReportIncidentSchema,
  PortalRequestMagicLinkSchema,
  type PortalSessionDto,
  type PortalUnitChangeRequestDto,
  PortalUnitChangeRequestSchema,
  type PushPublicKeyDto,
  PushSubscribeSchema,
  PushUnsubscribeSchema,
  type RedsysRedirectDto,
  RequestMoveOutSchema,
  type SetupIntentResponseDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { ThrottleLogin } from '../../common/decorators/throttle-presets';
import { AccessCredentialsService } from '../access/access-credentials.service';
import { ContractsService } from '../contracts/contracts.service';
import { IncidentsService } from '../operations/incidents.service';
import { RedsysService } from '../payments/redsys/redsys.service';
import { PushService } from '../push/push.service';
import { ReferralsService } from '../referrals/referrals.service';
import { UnitChangesService } from '../unit-changes/unit-changes.service';

import { NightPassService } from './night-pass.service';
import { PortalService } from './portal.service';

class PortalRequestMagicLinkDto extends createZodDto(PortalRequestMagicLinkSchema) {}
class PortalConsumeMagicLinkDto extends createZodDto(PortalConsumeMagicLinkSchema) {}
class PortalRegisterPaymentMethodDto extends createZodDto(PortalRegisterPaymentMethodSchema) {}
class PortalGoCardlessMandateCompleteDto extends createZodDto(
  PortalGoCardlessMandateCompleteSchema,
) {}
class RequestMoveOutDto extends createZodDto(RequestMoveOutSchema) {}
class PortalReportIncidentDto extends createZodDto(PortalReportIncidentSchema) {}
class PortalUpdateProfileDto extends createZodDto(PortalUpdateProfileSchema) {}
class PortalSetInsuranceDto extends createZodDto(PortalSetInsuranceSchema) {}
class PortalPurchaseDto extends createZodDto(PortalPurchaseSchema) {}
class PortalCreateExtraAccessDto extends createZodDto(PortalCreateExtraAccessSchema) {}
class PushSubscribeDto extends createZodDto(PushSubscribeSchema) {}
class PushUnsubscribeDto extends createZodDto(PushUnsubscribeSchema) {}
class PortalUnitChangeRequestDto2 extends createZodDto(PortalUnitChangeRequestSchema) {}

@Controller('portal')
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly redsys: RedsysService,
    private readonly access: AccessCredentialsService,
    private readonly referrals: ReferralsService,
    private readonly contracts: ContractsService,
    private readonly incidents: IncidentsService,
    private readonly push: PushService,
    private readonly unitChanges: UnitChangesService,
    private readonly nightPass: NightPassService,
  ) {}

  @Public()
  @ThrottleLogin()
  @Post('login/request')
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestLink(@Body() input: PortalRequestMagicLinkDto): Promise<void> {
    await this.portal.requestMagicLink(input);
  }

  @Public()
  @ThrottleLogin()
  @Post('login/consume')
  @HttpCode(HttpStatus.OK)
  async consume(@Body() input: PortalConsumeMagicLinkDto): Promise<PortalSessionDto> {
    return this.portal.consumeMagicLink(input.token);
  }

  @Public()
  @Get('me/invoices')
  async myInvoices(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalInvoiceDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.listMyInvoices(tenantId, customerId);
  }

  /** Accesorios a la venta (catálogo del negocio con stock). */
  @Public()
  @Get('me/products')
  async myProducts(@Headers('authorization') auth: string | undefined): Promise<ProductDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.listProducts(tenantId, customerId);
  }

  /** El inquilino compra accesorios → venta + factura emitida (pagable en el portal). */
  @Public()
  @Post('me/purchases')
  async purchase(
    @Headers('authorization') auth: string | undefined,
    @Body() body: PortalPurchaseDto,
  ): Promise<ProductSaleDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.purchaseProducts(tenantId, customerId, body.items);
  }

  /** Planes de seguro/protección que ofrece el negocio. */
  @Public()
  @Get('me/insurance-plans')
  async myInsurancePlans(
    @Headers('authorization') auth: string | undefined,
  ): Promise<InsurancePlanDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.listInsurancePlans(tenantId, customerId);
  }

  /** El inquilino contrata (planId) o quita (null) el seguro en uno de sus contratos. */
  @Public()
  @Put('me/contracts/:id/insurance')
  async setMyContractInsurance(
    @Headers('authorization') auth: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PortalSetInsuranceDto,
  ): Promise<PortalContractDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.setMyContractInsurance(tenantId, customerId, id, body.planId);
  }

  /** Datos de perfil del inquilino (contacto + facturación). */
  @Public()
  @Get('me/profile')
  async myProfile(@Headers('authorization') auth: string | undefined): Promise<PortalProfileDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.getMyProfile(tenantId, customerId);
  }

  /** El inquilino edita sus datos de contacto y facturación (no el email). */
  @Public()
  @Patch('me/profile')
  async updateMyProfile(
    @Headers('authorization') auth: string | undefined,
    @Body() body: PortalUpdateProfileDto,
  ): Promise<PortalProfileDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.updateMyProfile(tenantId, customerId, body);
  }

  /** Historial de cobros (transacciones de pago) del inquilino. */
  @Public()
  @Get('me/payments')
  async myPayments(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalPaymentDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.listMyPayments(tenantId, customerId);
  }

  /** Locales del inquilino (dirección, horario de acceso, contacto). */
  @Public()
  @Get('me/facilities')
  async myFacilities(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalFacilityDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.listMyFacilities(tenantId, customerId);
  }

  // ----------------------- acceso por QR/PIN -------------------------------

  @Public()
  @Get('me/access')
  async myAccess(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalAccessCredentialDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.access.listForCustomer(tenantId, customerId);
  }

  // ----------------------- contratos / move-out ----------------------------

  @Public()
  @Get('me/contracts')
  async myContracts(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalContractDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.contracts.listForCustomer(tenantId, customerId);
  }

  /** URL temporal para descargar el PDF del contrato firmado. */
  @Public()
  @Get('me/contracts/:id/signed-pdf')
  async myContractPdf(
    @Headers('authorization') auth: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PortalDownloadDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.getMyContractPdf(tenantId, customerId, id);
  }

  @Public()
  @ThrottleLogin()
  @Post('me/contracts/:id/request-move-out')
  @HttpCode(HttpStatus.OK)
  async requestMoveOut(
    @Headers('authorization') auth: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: RequestMoveOutDto,
  ): Promise<PortalContractDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.contracts.requestEndByCustomer({
      tenantId,
      customerId,
      contractId: id,
      endDate: input.endDate,
    });
  }

  // ----------------------- incidencias -------------------------------------

  @Public()
  @Get('me/incidents')
  async myIncidents(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalIncidentDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.incidents.listForCustomer(tenantId, customerId);
  }

  @Public()
  @ThrottleLogin()
  @Post('me/incidents')
  async reportIncident(
    @Headers('authorization') auth: string | undefined,
    @Body() input: PortalReportIncidentDto,
  ): Promise<PortalIncidentDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.incidents.createFromPortal({ tenantId, customerId, input });
  }

  // ----------------------- notificaciones push -----------------------------

  @Public()
  @Get('me/push/public-key')
  async pushPublicKey(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PushPublicKeyDto> {
    await this.requirePortalSession(auth);
    return { publicKey: this.push.getPublicKey() };
  }

  @Public()
  @ThrottleLogin()
  @Post('me/push/subscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  async pushSubscribe(
    @Headers('authorization') auth: string | undefined,
    @Body() input: PushSubscribeDto,
  ): Promise<void> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    await this.push.subscribe(tenantId, customerId, input);
  }

  @Public()
  @ThrottleLogin()
  @Post('me/push/unsubscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  async pushUnsubscribe(
    @Headers('authorization') auth: string | undefined,
    @Body() input: PushUnsubscribeDto,
  ): Promise<void> {
    const { tenantId } = await this.requirePortalSession(auth);
    await this.push.unsubscribe(tenantId, input.endpoint);
  }

  // ----------------------- cambio de trastero ------------------------------

  @Public()
  @Get('me/unit-change-requests')
  async myUnitChangeRequests(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalUnitChangeRequestDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.unitChanges.listForCustomer(tenantId, customerId);
  }

  @Public()
  @ThrottleLogin()
  @Post('me/unit-change-requests')
  async requestUnitChange(
    @Headers('authorization') auth: string | undefined,
    @Body() input: PortalUnitChangeRequestDto2,
  ): Promise<PortalUnitChangeRequestDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.unitChanges.createFromPortal({ tenantId, customerId, input });
  }

  // ----------------------- referidos ---------------------------------------

  @Public()
  @Get('me/referrals')
  async myReferrals(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalReferralDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.referrals.getPortalView(tenantId, customerId);
  }

  @Public()
  @ThrottleLogin()
  @Post('me/access/:id/regenerate')
  @HttpCode(HttpStatus.OK)
  async regenerateAccess(
    @Headers('authorization') auth: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PortalAccessCredentialDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.access.regenerateForCustomer(tenantId, customerId, id);
  }

  /** El inquilino se crea un acceso adicional (familiar, etc.) hasta el límite. */
  @Public()
  @ThrottleLogin()
  @Post('me/access/extra')
  async createExtraAccess(
    @Headers('authorization') auth: string | undefined,
    @Body() input: PortalCreateExtraAccessDto,
  ): Promise<PortalAccessCredentialDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.access.createExtraForCustomer(tenantId, customerId, input.label);
  }

  /** Disponibilidad + precio del pase nocturno (para la card del portal). */
  @Public()
  @Get('me/access/night-pass')
  async nightPassInfo(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalNightPassInfoDto> {
    const { tenantId } = await this.requirePortalSession(auth);
    return this.nightPass.info(tenantId);
  }

  /** El inquilino compra un pase nocturno (código de un solo uso, se factura). */
  @Public()
  @ThrottleLogin()
  @Post('me/access/night-pass')
  async buyNightPass(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalAccessCredentialDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.nightPass.buy(tenantId, customerId);
  }

  @Public()
  @Get('me/payment-methods')
  async myPaymentMethods(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PaymentMethodDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.listMyPaymentMethods(tenantId, customerId);
  }

  @Public()
  @ThrottleLogin()
  @Post('me/payment-methods/setup-intent')
  @HttpCode(HttpStatus.OK)
  async mySetupIntent(
    @Headers('authorization') auth: string | undefined,
  ): Promise<SetupIntentResponseDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.createMySetupIntent(tenantId, customerId);
  }

  @Public()
  @ThrottleLogin()
  @Post('me/payment-methods')
  async registerMyPaymentMethod(
    @Headers('authorization') auth: string | undefined,
    @Body() input: PortalRegisterPaymentMethodDto,
  ): Promise<PaymentMethodDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.registerMyPaymentMethod(tenantId, customerId, input);
  }

  @Public()
  @Get('me/gocardless/enabled')
  async goCardlessEnabled(
    @Headers('authorization') auth: string | undefined,
  ): Promise<{ enabled: boolean }> {
    const { tenantId } = await this.requirePortalSession(auth);
    return { enabled: await this.portal.isGoCardlessEnabled(tenantId) };
  }

  @Public()
  @ThrottleLogin()
  @Post('me/gocardless/mandate/start')
  @HttpCode(HttpStatus.OK)
  async startMyGoCardlessMandate(
    @Headers('authorization') auth: string | undefined,
  ): Promise<GoCardlessMandateStartDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.startMyGoCardlessMandate(tenantId, customerId);
  }

  @Public()
  @ThrottleLogin()
  @Post('me/gocardless/mandate/complete')
  @HttpCode(HttpStatus.OK)
  async completeMyGoCardlessMandate(
    @Headers('authorization') auth: string | undefined,
    @Body() body: PortalGoCardlessMandateCompleteDto,
  ): Promise<PaymentMethodDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.completeMyGoCardlessMandate(tenantId, customerId, body.billingRequestId);
  }

  @Public()
  @ThrottleLogin()
  @Post('me/invoices/:id/charge')
  @HttpCode(HttpStatus.OK)
  async chargeMyInvoice(
    @Headers('authorization') auth: string | undefined,
    @Param('id', ParseUUIDPipe) invoiceId: string,
  ): Promise<PortalChargeResultDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.portal.chargeMyInvoice(tenantId, customerId, invoiceId);
  }

  @Public()
  @ThrottleLogin()
  @Post('me/invoices/:id/redsys-redirect')
  @HttpCode(HttpStatus.OK)
  async redsysRedirect(
    @Headers('authorization') auth: string | undefined,
    @Param('id', ParseUUIDPipe) invoiceId: string,
  ): Promise<RedsysRedirectDto> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.redsys.createRedirect(tenantId, invoiceId, customerId);
  }

  /**
   * Auth manual del portal: el JWT corto (purpose 'portal') viaja como
   * Bearer. No hay guard dedicado porque el resto del API usa JwtAuthGuard
   * de staff y estos endpoints son @Public por diseño.
   */
  private async requirePortalSession(
    auth: string | undefined,
  ): Promise<{ customerId: string; tenantId: string }> {
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'portal_token_required',
        message: 'Token requerido',
      });
    }
    return this.portal.verifyPortalToken(auth.slice('Bearer '.length));
  }
}
