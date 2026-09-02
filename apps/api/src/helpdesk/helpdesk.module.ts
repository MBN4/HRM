import { Module } from '@nestjs/common';
import { HelpdeskController } from './helpdesk.controller';
import { TicketCategoryService } from './ticket-category.service';
import { TicketService } from './ticket.service';
import { TicketSlaService } from './ticket-sla.service';

/** The HR Helpdesk / Ticketing module (step 3.1) — see docs/conventions/operations-modules.md. `StorageService` needs no explicit import — `@Global()`. */
@Module({
  controllers: [HelpdeskController],
  providers: [TicketCategoryService, TicketService, TicketSlaService],
  exports: [TicketService, TicketSlaService],
})
export class HelpdeskModule {}
