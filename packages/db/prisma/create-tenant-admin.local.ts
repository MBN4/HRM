import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const tenantSlug = 'acme-demo';
const email = 'admin@acme-demo.local';
const password = 'ChangeMe-Tenant-Admin-123!';
const ARGON2ID = 2;

async function main() {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
  if (tenant.status !== 'ACTIVE') throw new Error(`Tenant ${tenantSlug} is ${tenant.status}`);

  const role = await prisma.role.findFirstOrThrow({
    where: { tenantId: tenant.id, name: 'TENANT_ADMIN' },
  });
  const hashedPassword = await hash(password, { algorithm: ARGON2ID });

  let user = await prisma.user.findFirst({ where: { tenantId: tenant.id, email } });
  const userAction = user ? 'Updated' : 'Created';
  user = user
    ? await prisma.user.update({
        where: { id: user.id },
        data: { hashedPassword, status: 'ACTIVE' },
      })
    : await prisma.user.create({
        data: { tenantId: tenant.id, email, hashedPassword, status: 'ACTIVE' },
      });

  const link = await prisma.userRole.findFirst({
    where: { tenantId: tenant.id, userId: user.id, roleId: role.id },
  });
  if (!link) {
    await prisma.userRole.create({
      data: { tenantId: tenant.id, userId: user.id, roleId: role.id },
    });
  }

  console.log(`${userAction} user: ${user.id} (${email})`);
  console.log(`${link ? 'Existing' : 'Created'} TENANT_ADMIN role link: ${role.id}`);

  // Read from the database again to verify the persisted state.
  const verified = await prisma.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email },
    select: {
      id: true,
      tenantId: true,
      email: true,
      status: true,
      roles: { select: { role: { select: { name: true } } } },
    },
  });
  if (
    verified.status !== 'ACTIVE' ||
    !verified.roles.some(({ role }) => role.name === 'TENANT_ADMIN')
  ) {
    throw new Error('Database verification failed');
  }
  console.log(
    'Verified in DB:',
    JSON.stringify({
      tenantSlug,
      tenantId: verified.tenantId,
      userId: verified.id,
      email: verified.email,
      status: verified.status,
      roles: verified.roles.map(({ role }) => role.name),
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
