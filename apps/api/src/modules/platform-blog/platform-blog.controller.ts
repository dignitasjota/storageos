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
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  CreatePlatformBlogPostSchema,
  RequestPlatformBlogCoverSchema,
  SetPlatformBlogCoverSchema,
  UpdatePlatformBlogPostSchema,
  type BlogCoverUploadResponseDto,
  type PlatformBlogPostDto,
  type PublicPlatformBlogPostDto,
  type PublicPlatformBlogPostSummaryDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminAudit } from '../admin/admin-audit.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

import { PlatformBlogService } from './platform-blog.service';

class CreatePostDto extends createZodDto(CreatePlatformBlogPostSchema) {}
class UpdatePostDto extends createZodDto(UpdatePlatformBlogPostSchema) {}
class CoverUploadDto extends createZodDto(RequestPlatformBlogCoverSchema) {}
class SetCoverDto extends createZodDto(SetPlatformBlogCoverSchema) {}

/** Entradas publicadas del blog de trasteros.pro. */
@Public()
@Controller('platform-blog')
export class PlatformBlogPublicController {
  constructor(private readonly service: PlatformBlogService) {}

  @Get()
  list(): Promise<PublicPlatformBlogPostSummaryDto[]> {
    return this.service.listPublished();
  }

  @Get(':slug')
  get(@Param('slug') slug: string): Promise<PublicPlatformBlogPostDto> {
    return this.service.getPublished(slug);
  }
}

/** Panel admin → Blog de TrasterOS. Leer: super admins; escribir: rol superadmin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/platform/blog')
export class PlatformBlogAdminController {
  constructor(private readonly service: PlatformBlogService) {}

  @Get()
  list(): Promise<PlatformBlogPostDto[]> {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<PlatformBlogPostDto> {
    return this.service.get(id);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.blog_post_created')
  @Post()
  create(@Body() body: CreatePostDto): Promise<PlatformBlogPostDto> {
    return this.service.create(body);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.blog_post_updated')
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdatePostDto,
  ): Promise<PlatformBlogPostDto> {
    return this.service.update(id, body);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.blog_post_deleted')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.remove(id);
  }

  @RequireSuperadmin()
  @Post(':id/cover-upload-url')
  @HttpCode(HttpStatus.OK)
  async coverUploadUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CoverUploadDto,
  ): Promise<BlogCoverUploadResponseDto> {
    const { uploadUrl, key, expiresIn } = await this.service.requestCoverUpload({
      id,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      ...(body.fileName ? { fileName: body.fileName } : {}),
    });
    return { uploadUrl, key, expiresIn, requiredHeaders: { 'Content-Type': body.mimeType } };
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.blog_post_cover_set')
  @Put(':id/cover')
  setCover(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SetCoverDto,
  ): Promise<PlatformBlogPostDto> {
    return this.service.setCover(id, body.coverImageKey);
  }
}
