import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  BulkCustomerMessageSchema,
  BulkCustomerTagsSchema,
  CreateCustomerDocumentRequestSchema,
  CustomerMessageSchema,
  FacilityMessageSchema,
  MergeCustomerSchema,
  SaveCustomerViewSchema,
  UpsertCustomerContactSchema,
  permissionsForRole,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CustomerScopeGuard } from '../../common/customer-scope';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerInsightsService } from './customer-insights.service';
import { CustomerMergeService } from './customer-merge.service';
import { CustomerTimelineService } from './customer-timeline.service';
import { CustomerToolsService } from './customer-tools.service';

import type {
  CustomerContactDto,
  CustomerDocumentRequestDto,
  CustomerInsightsDto,
  CustomerMergePreviewDto,
  CustomerSavedViewDto,
  CustomerTimelineItemDto,
  DeletedCustomerDto,
} from '@storageos/shared';
import type { Request } from 'express';

class MergeCustomerDto extends createZodDto(MergeCustomerSchema) {}
class ContactDto extends createZodDto(UpsertCustomerContactSchema) {}
class DocumentRequestDto extends createZodDto(CreateCustomerDocumentRequestSchema) {}
class SaveViewDto extends createZodDto(SaveCustomerViewSchema) {}
class BulkTagsDto extends createZodDto(BulkCustomerTagsSchema) {}
class BulkMessageDto extends createZodDto(BulkCustomerMessageSchema) {}
class MessageDto extends createZodDto(CustomerMessageSchema) {}
class FacilityMessageDto extends createZodDto(FacilityMessageSchema) {}

const permissionsOf = (user: AuthenticatedUser) =>
  user.permissions ?? permissionsForRole(user.role);
const moneyVisible = (user: AuthenticatedUser) => {
  const p = permissionsOf(user);
  return p.includes('invoices:read') && p.includes('payments:read');
};

/** Se registra antes que `CustomersController` para que `views` o `deleted` no caigan en `:id`. */
@Controller('customers')
@UseGuards(CustomerScopeGuard)
export class CustomerFeaturesController {
  constructor(
    private readonly merge: CustomerMergeService,
    private readonly timelineService: CustomerTimelineService,
    private readonly insightsService: CustomerInsightsService,
    private readonly tools: CustomerToolsService,
  ) {}

  @RequirePermission('customers:read')
  @Get('views')
  views(@CurrentUser() user: AuthenticatedUser): Promise<CustomerSavedViewDto[]> {
    return this.tools.listViews(user.tenantId);
  }

  @RequirePermission('customers:write')
  @Post('views')
  saveView(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: SaveViewDto,
  ): Promise<CustomerSavedViewDto> {
    return this.tools.saveView(user.tenantId, user.sub, input);
  }

  @RequirePermission('customers:write')
  @Delete('views/:viewId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteView(
    @CurrentUser() user: AuthenticatedUser,
    @Param('viewId', new ParseUUIDPipe()) viewId: string,
  ): Promise<void> {
    await this.tools.deleteView(user.tenantId, viewId);
  }

  @RequirePermission('customers:read')
  @Get('deleted')
  deleted(@CurrentUser() user: AuthenticatedUser): Promise<DeletedCustomerDto[]> {
    return this.tools.listDeleted(user.tenantId, user.facilityScope ?? null);
  }

  @RequirePermission('customers:write')
  @Post('bulk/tags')
  @HttpCode(HttpStatus.OK)
  bulkTags(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: BulkTagsDto,
  ): Promise<{ updated: number }> {
    return this.tools.bulkTags(user.tenantId, input, user.facilityScope ?? null);
  }

  @RequirePermission('communications:send')
  @Post('bulk/message')
  @HttpCode(HttpStatus.OK)
  bulkMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: BulkMessageDto,
  ): Promise<{ sent: number; skipped: number }> {
    return this.tools.bulkMessage(user.tenantId, input, user.facilityScope ?? null);
  }

  /** Aviso a los inquilinos en vigor de un local. */
  @RequirePermission('communications:send')
  @Post('by-facility/:facilityId/message')
  @HttpCode(HttpStatus.OK)
  messageFacility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('facilityId', new ParseUUIDPipe()) facilityId: string,
    @Body() input: FacilityMessageDto,
  ): Promise<{ sent: number }> {
    return this.tools.messageFacility(
      user.tenantId,
      user.sub,
      facilityId,
      input,
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('customers:delete')
  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.tools.restore(user.tenantId, user.sub, id);
  }

  @RequirePermission('customers:read')
  @Get(':id/merge-preview')
  mergePreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('sourceId', new ParseUUIDPipe()) sourceId: string,
  ): Promise<CustomerMergePreviewDto> {
    return this.merge.preview(user.tenantId, id, sourceId, user.facilityScope ?? null);
  }

  @RequirePermission('customers:delete')
  @Post(':id/merge')
  @HttpCode(HttpStatus.NO_CONTENT)
  async doMerge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: MergeCustomerDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.merge.merge({
      tenantId: user.tenantId,
      userId: user.sub,
      targetId: id,
      sourceId: input.sourceId,
      facilityScope: user.facilityScope ?? null,
      meta: { ipAddress: req.ip, userAgent: req.header('user-agent') },
    });
  }

  @RequirePermission('customers:read')
  @Get(':id/timeline')
  timeline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerTimelineItemDto[]> {
    return this.timelineService.timeline(user.tenantId, id, {
      facilityScope: user.facilityScope ?? null,
      permissions: permissionsOf(user),
    });
  }

  @RequirePermission('customers:read')
  @Get(':id/insights')
  insights(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerInsightsDto> {
    return this.insightsService.insights(user.tenantId, id, {
      facilityScope: user.facilityScope ?? null,
      moneyVisible: moneyVisible(user),
    });
  }

  @RequirePermission('communications:send')
  @Post(':id/message')
  @HttpCode(HttpStatus.OK)
  message(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: MessageDto,
  ): Promise<{ recipient: string }> {
    return this.tools.sendMessage(user.tenantId, id, input);
  }

  @RequirePermission('customers:read')
  @Get(':id/contacts')
  contacts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerContactDto[]> {
    return this.tools.listContacts(user.tenantId, id);
  }

  @RequirePermission('customers:write')
  @Post(':id/contacts')
  addContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ContactDto,
  ): Promise<CustomerContactDto> {
    return this.tools.addContact(user.tenantId, id, input);
  }

  @RequirePermission('customers:write')
  @Patch(':id/contacts/:contactId')
  updateContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body() input: ContactDto,
  ): Promise<CustomerContactDto> {
    return this.tools.updateContact(user.tenantId, id, contactId, input);
  }

  @RequirePermission('customers:write')
  @Delete(':id/contacts/:contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
  ): Promise<void> {
    await this.tools.removeContact(user.tenantId, id, contactId);
  }

  @RequirePermission('customers:read')
  @Get(':id/document-requests')
  documentRequests(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerDocumentRequestDto[]> {
    return this.tools.listRequests(user.tenantId, id);
  }

  @RequirePermission('customers:write')
  @Post(':id/document-requests')
  requestDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: DocumentRequestDto,
  ): Promise<CustomerDocumentRequestDto> {
    return this.tools.requestDocument({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId: id,
      input,
    });
  }

  @RequirePermission('customers:write')
  @Delete(':id/document-requests/:requestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
  ): Promise<void> {
    await this.tools.cancelRequest(user.tenantId, id, requestId);
  }
}
