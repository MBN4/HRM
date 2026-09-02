import { Module } from '@nestjs/common';
import { AnnouncementsController } from './announcements.controller';
import { AnnouncementService } from './announcement.service';
import { PolicyService } from './policy.service';

/** The Announcements & Policies module (step 3.1) — see docs/conventions/operations-modules.md. Self-contained; wires the ESS "announcements seam" left in 1.4 to real data. */
@Module({
  controllers: [AnnouncementsController],
  providers: [AnnouncementService, PolicyService],
  exports: [AnnouncementService, PolicyService],
})
export class AnnouncementsModule {}
