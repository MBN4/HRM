import { Module } from '@nestjs/common';
import { CustomFieldDefinitionService } from './custom-field-definition.service';
import { CustomFieldValueService } from './custom-field-value.service';
import { CustomFieldsController } from './custom-fields.controller';

@Module({
  controllers: [CustomFieldsController],
  providers: [CustomFieldDefinitionService, CustomFieldValueService],
  exports: [CustomFieldDefinitionService, CustomFieldValueService],
})
export class CustomFieldsModule {}
