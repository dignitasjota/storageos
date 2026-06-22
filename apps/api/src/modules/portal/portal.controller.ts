import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type PortalAccessCredentialDto,
  PortalConsumeMagicLinkSchema,
  type PaymentMethodDto,
  type PortalChargeResultDto,
  type PortalInvoiceDto,
  type PortalReferralDto,
  PortalRegisterPaymentMethodSchema,
  PortalRequestMagicLinkSchema,
  type PortalSessionDto,
  type RedsysRedirectDto,
  type SetupIntentResponseDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { ThrottleLogin } from '../../common/decorators/throttle-presets';
import { AccessCredentialsService } from '../access/access-credentials.service';
import { RedsysService } from '../payments/redsys/redsys.service';
import { ReferralsService } from '../referrals/referrals.service';

import { PortalService } from './portal.service';

class PortalRequestMagicLinkDto extends createZodDto(PortalRequestMagicLinkSchema) {}
class PortalConsumeMagicLinkDto extends createZodDto(PortalConsumeMagicLinkSchema) {}
class PortalRegisterPaymentMethodDto extends createZodDto(PortalRegisterPaymentMethodSchema) {}

@Controller('portal')
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly redsys: RedsysService,
    private readonly access: AccessCredentialsService,
    private readonly referrals: ReferralsService,
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

  // ----------------------- acceso por QR/PIN -------------------------------

  @Public()
  @Get('me/access')
  async myAccess(
    @Headers('authorization') auth: string | undefined,
  ): Promise<PortalAccessCredentialDto[]> {
    const { customerId, tenantId } = await this.requirePortalSession(auth);
    return this.access.listForCustomer(tenantId, customerId);
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
