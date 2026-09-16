#!/usr/bin/env node
'use strict';
/*
 * Phase 6.2 backups — object-storage export helper for backup-minio.sh.
 *
 * Reuses @aws-sdk/client-s3, already a dependency of apps/api (see
 * apps/api/src/storage/storage.service.ts) — deliberately not a new
 * mc/aws-cli dependency, per this step's own constraint. Resolved via an
 * explicit path into apps/api's own node_modules, since this script lives
 * outside that package's own dependency tree and plain `require()` would
 * not otherwise find it.
 *
 * Lists every object in S3_BUCKET and downloads each one verbatim into
 * OUT_DIR/objects/<key>, alongside a manifest.json recording every key's
 * size + sha256 for later integrity verification. This bucket holds both
 * ordinary document uploads (1.1 EmployeeDocument, 2.1 payslips, etc.) AND
 * the already-archived partition exports PartitionArchivalService writes
 * to archives/<table>/<partition>.jsonl.gz (see
 * docs/conventions/partitioning-archival.md) — a plain bucket-wide
 * List+Get sweep covers both with no special-casing needed.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const s3ModPath = path.join(REPO_ROOT, 'apps/api/node_modules/@aws-sdk/client-s3');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require(s3ModPath);

const OUT_DIR = process.argv[2];
if (!OUT_DIR) {
  console.error('usage: node minio-export.js <out-dir>');
  process.exit(1);
}

const endpoint = process.env.S3_ENDPOINT;
const region = process.env.S3_REGION;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
const bucket = process.env.S3_BUCKET;
const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';

for (const [name, value] of Object.entries({
  S3_ENDPOINT: endpoint,
  S3_REGION: region,
  S3_ACCESS_KEY_ID: accessKeyId,
  S3_SECRET_ACCESS_KEY: secretAccessKey,
  S3_BUCKET: bucket,
})) {
  if (!value) {
    console.error(`missing required env var ${name}`);
    process.exit(1);
  }
}

const client = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle,
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = { bucket, exportedAt: new Date().toISOString(), objects: [] };

  let continuationToken;
  let totalBytes = 0;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );
    for (const obj of page.Contents ?? []) {
      const key = obj.Key;
      const dest = path.join(OUT_DIR, 'objects', key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await streamToBuffer(got.Body);
      fs.writeFileSync(dest, body);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      manifest.objects.push({ key, bytes: body.length, sha256 });
      totalBytes += body.length;
      console.log(`[minio-export] ${key} (${body.length} bytes)`);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[minio-export] done: ${manifest.objects.length} object(s), ${totalBytes} bytes total`);
}

main().catch((err) => {
  console.error('[minio-export] failed:', err);
  process.exit(1);
});
