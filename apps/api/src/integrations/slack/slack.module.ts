import { Module } from '@nestjs/common';
import { SlackConfigController } from './slack-config.controller';
import { SlackConfigService } from './slack-config.service';

@Module({
  controllers: [SlackConfigController],
  providers: [SlackConfigService],
})
export class SlackModule {}
