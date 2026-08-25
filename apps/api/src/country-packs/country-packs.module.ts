import { Module } from '@nestjs/common';
import { CountryPacksController } from './country-packs.controller';
import { CountryPackResolutionService } from './country-pack-resolution.service';

@Module({
  controllers: [CountryPacksController],
  providers: [CountryPackResolutionService],
  exports: [CountryPackResolutionService],
})
export class CountryPacksModule {}
