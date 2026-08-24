import { Injectable } from '@nestjs/common';
import { APP_NAME } from '@hrm/shared';

@Injectable()
export class AppService {
  getHealth() {
    return { status: 'ok', service: APP_NAME };
  }
}
