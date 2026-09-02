import { z } from 'zod';

/** Asset Management (step 3.1) — see docs/conventions/operations-modules.md. */
export const createAssetCategorySchema = z
  .object({
    code: z.string().min(1).max(50),
    name: z.string().min(1).max(200),
  })
  .strict();
export type CreateAssetCategoryInput = z.infer<typeof createAssetCategorySchema>;

export const createAssetSchema = z
  .object({
    categoryId: z.string().uuid(),
    branchId: z.string().uuid().optional(),
    assetTag: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    serialNumber: z.string().max(200).optional(),
    purchaseDate: z.coerce.date().optional(),
    purchaseCost: z.number().nonnegative().optional(),
  })
  .strict();
export type CreateAssetInput = z.infer<typeof createAssetSchema>;

export const assignAssetSchema = z
  .object({
    assetId: z.string().uuid(),
    employeeId: z.string().uuid(),
    condition: z.string().max(500).optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();
export type AssignAssetInput = z.infer<typeof assignAssetSchema>;

export const returnAssetSchema = z
  .object({
    returnCondition: z.string().max(500).optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();
export type ReturnAssetInput = z.infer<typeof returnAssetSchema>;

export const createMaintenanceRecordSchema = z
  .object({
    assetId: z.string().uuid(),
    description: z.string().min(1).max(1000),
    startedAt: z.coerce.date().optional(),
    cost: z.number().nonnegative().optional(),
  })
  .strict();
export type CreateMaintenanceRecordInput = z.infer<typeof createMaintenanceRecordSchema>;

export const completeMaintenanceRecordSchema = z
  .object({
    cost: z.number().nonnegative().optional(),
  })
  .strict();
export type CompleteMaintenanceRecordInput = z.infer<typeof completeMaintenanceRecordSchema>;
