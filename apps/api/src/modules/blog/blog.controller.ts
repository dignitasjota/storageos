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
} from '@nestjs/common';
import {
  type BlogCoverUploadResponseDto,
  type BlogPostDto,
  CreateBlogPostSchema,
  RequestBlogCoverUploadSchema,
  SetBlogPostCoverSchema,
  UpdateBlogPostSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { BlogService } from './blog.service';

class CreateBlogPostDto extends createZodDto(CreateBlogPostSchema) {}
class UpdateBlogPostDto extends createZodDto(UpdateBlogPostSchema) {}
class RequestBlogCoverUploadDto extends createZodDto(RequestBlogCoverUploadSchema) {}
class SetBlogPostCoverDto extends createZodDto(SetBlogPostCoverSchema) {}

/** Gestión del blog del tenant (lado staff). Feature `web_premium`. */
@RequireFeature('web_premium')
@Controller('blog-posts')
export class BlogController {
  constructor(private readonly blog: BlogService) {}

  @RequirePermission('settings:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<BlogPostDto[]> {
    return this.blog.list(user.tenantId);
  }

  @RequirePermission('settings:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BlogPostDto> {
    return this.blog.detail(user.tenantId, id);
  }

  @RequirePermission('settings:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateBlogPostDto,
  ): Promise<BlogPostDto> {
    return this.blog.create(user.tenantId, body);
  }

  @RequirePermission('settings:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateBlogPostDto,
  ): Promise<BlogPostDto> {
    return this.blog.update(user.tenantId, id, body);
  }

  @RequirePermission('settings:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.blog.remove(user.tenantId, id);
  }

  @RequirePermission('settings:manage')
  @Post(':id/cover/upload-url')
  @HttpCode(HttpStatus.OK)
  async requestCoverUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: RequestBlogCoverUploadDto,
  ): Promise<BlogCoverUploadResponseDto> {
    const { uploadUrl, key, expiresIn } = await this.blog.requestCoverUploadUrl({
      tenantId: user.tenantId,
      id,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
    return { uploadUrl, key, expiresIn, requiredHeaders: { 'Content-Type': input.mimeType } };
  }

  @RequirePermission('settings:manage')
  @Put(':id/cover')
  setCover(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SetBlogPostCoverDto,
  ): Promise<BlogPostDto> {
    return this.blog.setCover(user.tenantId, id, body.coverImageKey);
  }
}
