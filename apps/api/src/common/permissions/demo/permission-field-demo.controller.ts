import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { PermissionSerializerInterceptor } from '../permission-serializer.interceptor';
import { PermissionFieldDemoDto } from './permission-field-demo.dto';

@Controller('tenancy')
export class PermissionFieldDemoController {
  @Get('permission-field-demo')
  @UseInterceptors(PermissionSerializerInterceptor)
  get(): PermissionFieldDemoDto {
    return new PermissionFieldDemoDto({
      id: 'demo-1',
      name: 'Jane Doe',
      department: 'Engineering',
      salary: 95000,
    });
  }
}
