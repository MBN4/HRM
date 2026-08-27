import { Module } from '@nestjs/common';
import { CountryPacksModule } from '../../country-packs/country-packs.module';
import { I18nDemoController } from './i18n-demo.controller';
import { TimezoneService } from './timezone.service';

@Module({
  imports: [CountryPacksModule],
  controllers: [I18nDemoController],
  providers: [TimezoneService],
  exports: [TimezoneService],
})
export class I18nModule {}
