import { Controller, Get } from '@nestjs/common';
import { PlatformRoute } from '../tenancy/platform-route.decorator';

/**
 * Seam for the future vendor super-admin surface — see
 * platform-route.decorator.ts for what this does and, more importantly,
 * does NOT yet do. `ping` is the minimal proof the seam works: it responds
 * only when PLATFORM_MODE_ENABLED=true, and never touches tenant data.
 */
@Controller('platform')
export class PlatformController {
  @Get('ping')
  @PlatformRoute()
  ping(): { platform: true } {
    return { platform: true };
  }
}
