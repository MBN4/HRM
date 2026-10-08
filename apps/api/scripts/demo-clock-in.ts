/**
 * DEV-ONLY (step 8.1 Part 3) — puts a demo member into a CLOCKED-IN state so the portal's LIVE ANALOG CLOCK
 * is demonstrable: writes an OPEN `attendance_records` row for today (backdated by N hours so the running
 * timer + goal ring already show progress). Any of today's existing records for that member are replaced.
 *
 *   pnpm --filter @hrm/api run demo:clock-in                      # intern@acme-demo.local, 3h ago
 *   pnpm --filter @hrm/api run demo:clock-in lead@acme-demo.local 5.5
 *   pnpm --filter @hrm/api run demo:clock-in intern@acme-demo.local --out   # clock them back OUT (day closes)
 *
 * Re-running `seed:demo` does NOT touch today's row for Ivy (her seeded month ends yesterday), so this is
 * the only thing that creates a live session. Clocking out through the UI afterwards is the real flow.
 */
import { prisma } from '@hrm/db';

const SLUG = 'acme-demo';
const args = process.argv.slice(2).filter((a) => !a.startsWith('dotenv_config_path'));
const EMAIL = args.find((a) => a.includes('@')) ?? 'intern@acme-demo.local';
const HOURS_AGO = Number(args.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 3);
const OUT = args.includes('--out');

const localYmd = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function main() {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SLUG } });
  const user = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: EMAIL } });
  const employee = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, userId: user.id }, include: { branch: true } });
  const tz = employee.branch.timezone;
  const now = new Date();
  const workDate = new Date(`${localYmd(now, tz)}T00:00:00Z`);

  // Today's (branch-local) rows only — and any still-open row from a previous session so there is exactly one.
  await prisma.attendanceRecord.deleteMany({ where: { tenantId: tenant.id, employeeId: employee.id, OR: [{ workDate }, { status: 'OPEN' }] } });

  if (OUT) {
    console.log(`${EMAIL}: today's records removed (not clocked in).`);
    return;
  }
  const clockInAt = new Date(now.getTime() - HOURS_AGO * 3_600_000);
  await prisma.attendanceRecord.create({
    data: {
      tenantId: tenant.id,
      employeeId: employee.id,
      branchId: employee.branchId,
      workDate: new Date(`${localYmd(clockInAt, tz)}T00:00:00Z`),
      clockInAt,
      clockInSource: 'WEB',
      status: 'OPEN',
    },
  });
  console.log(`${EMAIL} is now CLOCKED IN since ${clockInAt.toISOString()} (${HOURS_AGO}h ago, ${tz}). Sign in and open /dashboard — the live clock is running.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
