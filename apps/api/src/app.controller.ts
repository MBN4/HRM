import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Priority } from './resilience/load-shedding/priority.decorator';
import { Public } from './tenancy/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Priority('CRITICAL')
  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }
}
