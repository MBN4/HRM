import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { V1Module } from './integrations/v1/v1.module';

/**
 * OpenAPI/Swagger for the versioned public API (step 3.3) — factored out of
 * `main.ts` so the e2e suite can set it up against its own `TestingModule`-
 * built app too, without duplicating the config. `include: [V1Module]`
 * deliberately scopes generation to ONLY the versioned surface, not this
 * codebase's entire internal API — see `main.ts`'s doc comment for why.
 */
export function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('HRM Public API')
      .setDescription('The versioned (/v1), API-key-authenticated public REST surface — see docs/conventions/integrations.md.')
      .setVersion('1.0')
      .addApiKey({ type: 'apiKey', name: 'X-Api-Key', in: 'header' }, 'ApiKeyAuth')
      .build(),
    { include: [V1Module] },
  );
  SwaggerModule.setup('v1/docs', app, document);
}
