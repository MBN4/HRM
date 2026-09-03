import { Module } from '@nestjs/common';
import { ACCOUNTING_ADAPTER } from './accounting-adapter.interface';
import { AccountingExportController } from './accounting-export.controller';
import { NoopAccountingAdapter } from './noop-accounting.adapter';

@Module({
  controllers: [AccountingExportController],
  providers: [{ provide: ACCOUNTING_ADAPTER, useClass: NoopAccountingAdapter }],
})
export class AccountingModule {}
