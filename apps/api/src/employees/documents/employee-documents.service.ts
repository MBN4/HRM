import { Injectable, NotFoundException } from '@nestjs/common';
import type { EmployeeDocument, Prisma } from '@hrm/db';
import type { EmployeeDocumentTypeKey } from '@hrm/shared';
import { StorageService } from '../../storage/storage.service';

export interface UploadEmployeeDocumentParams {
  tenantId: string;
  employeeId: string;
  documentType: EmployeeDocumentTypeKey;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  uploadedByUserId: string | null;
}

function storageKeyFor(tenantId: string, employeeId: string, documentId: string, fileName: string): string {
  // Namespaced by tenant/employee so a directory listing of the bucket is
  // itself already tenant-partitioned, defense-in-depth alongside (never
  // instead of) the RLS-scoped `employee_documents` row that's the actual
  // authorization boundary for who can list/fetch it.
  return `employees/${tenantId}/${employeeId}/${documentId}-${fileName}`;
}

/**
 * Document METADATA lives in `employee_documents` (tenant-scoped, RLS); the
 * file bytes live in S3/MinIO via `StorageService` — see
 * docs/conventions/employee.md.
 */
@Injectable()
export class EmployeeDocumentsService {
  constructor(private readonly storage: StorageService) {}

  async upload(tx: Prisma.TransactionClient, params: UploadEmployeeDocumentParams): Promise<EmployeeDocument> {
    const row = await tx.employeeDocument.create({
      data: {
        tenantId: params.tenantId,
        employeeId: params.employeeId,
        documentType: params.documentType,
        fileName: params.fileName,
        mimeType: params.mimeType,
        sizeBytes: params.buffer.byteLength,
        // Placeholder until the real id is known — replaced immediately
        // below. Kept inside the same transaction so a storage-upload
        // failure rolls the row back too.
        storageKey: '',
        uploadedByUserId: params.uploadedByUserId,
      },
    });

    const storageKey = storageKeyFor(params.tenantId, params.employeeId, row.id, params.fileName);
    await this.storage.uploadObject({ key: storageKey, body: params.buffer, contentType: params.mimeType });
    return tx.employeeDocument.update({ where: { id: row.id }, data: { storageKey } });
  }

  async list(tx: Prisma.TransactionClient, employeeId: string): Promise<EmployeeDocument[]> {
    return tx.employeeDocument.findMany({ where: { employeeId }, orderBy: { createdAt: 'desc' } });
  }

  async requireOne(tx: Prisma.TransactionClient, employeeId: string, documentId: string): Promise<EmployeeDocument> {
    const row = await tx.employeeDocument.findFirst({ where: { id: documentId, employeeId } });
    if (!row) {
      throw new NotFoundException(`Document "${documentId}" was not found for employee "${employeeId}".`);
    }
    return row;
  }

  async download(row: EmployeeDocument) {
    return this.storage.downloadObject(row.storageKey);
  }
}
