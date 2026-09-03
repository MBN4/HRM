import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, UseInterceptors } from '@nestjs/common';
import {
  createCountryPackRequestSchema,
  createCountryPackVersionRequestSchema,
  PLATFORM_PERMISSIONS,
  updateCountryPackVersionRequestSchema,
  type CreateCountryPackInput,
  type CreateCountryPackVersionInput,
  type UpdateCountryPackVersionInput,
} from '@hrm/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PlatformRoute } from '../../tenancy/platform-route.decorator';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequirePlatformPermissions } from '../decorators/require-platform-permissions.decorator';
import { PlatformPermissionsGuard } from '../guards/platform-permissions.guard';
import { PlatformCountryPackService } from './platform-country-pack.service';

@Controller('platform/country-packs')
@PlatformRoute()
@UseInterceptors(PlatformPermissionsGuard)
export class PlatformCountryPackController {
  constructor(
    private readonly packs: PlatformCountryPackService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.COUNTRY_PACK_MANAGE)
  listCountries() {
    return this.packs.listCountries();
  }

  @Get(':countryCode')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.COUNTRY_PACK_MANAGE)
  listVersions(@Param('countryCode') countryCode: string) {
    return this.packs.listVersions(countryCode);
  }

  @Post()
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.COUNTRY_PACK_MANAGE)
  create(@Body(new ZodValidationPipe(createCountryPackRequestSchema)) body: CreateCountryPackInput) {
    return this.packs.create(this.requireActorId(), body);
  }

  @Post(':countryCode/versions')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.COUNTRY_PACK_MANAGE)
  createVersion(
    @Param('countryCode') countryCode: string,
    @Body(new ZodValidationPipe(createCountryPackVersionRequestSchema)) body: CreateCountryPackVersionInput,
  ) {
    return this.packs.createVersion(this.requireActorId(), countryCode, body);
  }

  @Put(':countryCode/versions/:version')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.COUNTRY_PACK_MANAGE)
  updateVersion(
    @Param('countryCode') countryCode: string,
    @Param('version', ParseIntPipe) version: number,
    @Body(new ZodValidationPipe(updateCountryPackVersionRequestSchema)) body: UpdateCountryPackVersionInput,
  ) {
    return this.packs.updateVersion(this.requireActorId(), countryCode, version, body);
  }

  @Post(':countryCode/versions/:version/activate')
  @RequirePlatformPermissions(PLATFORM_PERMISSIONS.COUNTRY_PACK_MANAGE)
  activate(@Param('countryCode') countryCode: string, @Param('version', ParseIntPipe) version: number) {
    return this.packs.activate(this.requireActorId(), countryCode, version);
  }

  private requireActorId(): string {
    const id = this.tenantContext.platformAdminId;
    if (!id) {
      throw new Error('Unreachable: this route requires an authenticated platform admin.');
    }
    return id;
  }
}
