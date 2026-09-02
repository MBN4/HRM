import { computeComplianceRows, computeCourseCompletionRows } from './lms-rollup.util';
import { determineComplianceBucket } from '../lms-compliance.util';

describe('computeCourseCompletionRows', () => {
  it('groups by branch/department/course and counts each status', () => {
    const rows = computeCourseCompletionRows([
      { branchId: 'b1', departmentId: 'd1', courseId: 'c1', status: 'ENROLLED' },
      { branchId: 'b1', departmentId: 'd1', courseId: 'c1', status: 'IN_PROGRESS' },
      { branchId: 'b1', departmentId: 'd1', courseId: 'c1', status: 'COMPLETED' },
      { branchId: 'b1', departmentId: 'd1', courseId: 'c1', status: 'COMPLETED' },
      { branchId: 'b2', departmentId: null, courseId: 'c1', status: 'ENROLLED' },
    ]);

    expect(rows).toHaveLength(2);
    const b1 = rows.find((r) => r.branchId === 'b1')!;
    expect(b1).toMatchObject({ enrolledCount: 4, inProgressCount: 1, completedCount: 2 });
    const b2 = rows.find((r) => r.branchId === 'b2')!;
    expect(b2).toMatchObject({ enrolledCount: 1, inProgressCount: 0, completedCount: 0 });
  });

  it('returns an empty array for no enrollments', () => {
    expect(computeCourseCompletionRows([])).toEqual([]);
  });

  it('treats a null departmentId as its own distinct grouping key', () => {
    const rows = computeCourseCompletionRows([
      { branchId: 'b1', departmentId: null, courseId: 'c1', status: 'ENROLLED' },
      { branchId: 'b1', departmentId: 'd1', courseId: 'c1', status: 'ENROLLED' },
    ]);
    expect(rows).toHaveLength(2);
  });
});

describe('computeComplianceRows', () => {
  it('groups by branch/department/course and buckets each pair', () => {
    const rows = computeComplianceRows([
      { branchId: 'b1', departmentId: 'd1', courseId: 'c1', bucket: 'COMPLIANT' },
      { branchId: 'b1', departmentId: 'd1', courseId: 'c1', bucket: 'EXPIRING' },
      { branchId: 'b1', departmentId: 'd1', courseId: 'c1', bucket: 'EXPIRED' },
      { branchId: 'b1', departmentId: 'd1', courseId: 'c1', bucket: 'MISSING' },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requiredCount: 4, compliantCount: 1, expiringCount: 1, expiredCount: 1, missingCount: 1 });
  });

  it('returns an empty array for no required pairs', () => {
    expect(computeComplianceRows([])).toEqual([]);
  });
});

describe('determineComplianceBucket', () => {
  const today = new Date('2026-06-15T00:00:00.000Z');

  it('is MISSING when no certification exists', () => {
    expect(determineComplianceBucket(undefined, today)).toBe('MISSING');
  });

  it('is EXPIRED when the certification status is already EXPIRED', () => {
    expect(determineComplianceBucket({ status: 'EXPIRED', expiresAt: new Date('2026-01-01') }, today)).toBe('EXPIRED');
  });

  it('is COMPLIANT for an ACTIVE certification with no expiry', () => {
    expect(determineComplianceBucket({ status: 'ACTIVE', expiresAt: null }, today)).toBe('COMPLIANT');
  });

  it('is COMPLIANT when expiry is more than 30 days out', () => {
    expect(determineComplianceBucket({ status: 'ACTIVE', expiresAt: new Date('2026-08-01') }, today)).toBe('COMPLIANT');
  });

  it('is EXPIRING within 30 days of expiry', () => {
    expect(determineComplianceBucket({ status: 'ACTIVE', expiresAt: new Date('2026-06-30') }, today)).toBe('EXPIRING');
  });

  it('is EXPIRED once the expiry date has passed, even if status is still ACTIVE', () => {
    expect(determineComplianceBucket({ status: 'ACTIVE', expiresAt: new Date('2026-06-01') }, today)).toBe('EXPIRED');
  });
});
