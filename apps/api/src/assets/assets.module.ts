import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { AssetCategoryService } from './asset-category.service';
import { AssetService } from './asset.service';

/**
 * The Asset Management module (step 3.1) — see
 * docs/conventions/operations-modules.md. Self-contained (no other
 * module's engine to reuse for its own CRUD/assignment lifecycle);
 * `OffboardingModule` imports THIS module to wire the clearance
 * checklist's real "asset return" step (see `assets.constants.ts`), the
 * SAME "the consuming module imports the reused one" direction every
 * other cross-module reuse in this codebase already takes.
 */
@Module({
  controllers: [AssetsController],
  providers: [AssetCategoryService, AssetService],
  exports: [AssetService],
})
export class AssetsModule {}
