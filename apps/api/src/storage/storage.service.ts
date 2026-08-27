import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

export interface UploadObjectParams {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface DownloadedObject {
  body: Readable;
  contentType: string | undefined;
}

/**
 * Thin S3-compatible object-storage seam — MinIO locally, any real
 * S3-compatible provider in prod, via the SAME `S3_*` env vars documented
 * (and unused) since step 0.1. First real consumer: `EmployeeDocument`
 * uploads (see docs/conventions/employee.md); written the same
 * "reusable module a future module just imports" way `QueueModule`/
 * `RedisModule` are — a future payslip/report-export module reuses this
 * service directly rather than standing up its own S3 client.
 *
 * Objects are addressed by an opaque `key` the CALLER constructs (see
 * `EmployeeDocumentsService` for the convention this module uses:
 * `employees/<tenantId>/<employeeId>/<documentId>-<fileName>`) — this
 * service has no opinion on key naming, matching the same "no opinion on
 * the caller's domain" posture `CustomFieldValueService` holds for
 * `entityType`/`entityId`.
 *
 * Downloads are STREAMED back through the API (`getObject` returns the
 * SDK's readable body stream directly) rather than via a presigned URL —
 * simpler for local dev (MinIO's container-internal endpoint isn't
 * externally reachable without extra reverse-proxy config) and keeps every
 * document access subject to this app's own RBAC/RLS checks on the way
 * out, not a separately-time-limited unauthenticated URL.
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    const endpoint = config.get<string>('S3_ENDPOINT');
    const region = config.get<string>('S3_REGION');
    const accessKeyId = config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY');
    const bucket = config.get<string>('S3_BUCKET');
    if (!endpoint || !region || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error('S3_ENDPOINT/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET must all be set.');
    }
    this.bucket = bucket;
    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE') === 'true',
    });
  }

  async uploadObject(params: UploadObjectParams): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
      }),
    );
  }

  async downloadObject(key: string): Promise<DownloadedObject> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { body: result.Body as Readable, contentType: result.ContentType };
  }
}
