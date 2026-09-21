import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';

const prisma = new PrismaClient();

async function main() {
  const tenantSlug = 'acme-demo';
  const email = 'admin@acme-demo.local';
  const password = 'ChangeMe-Tenant-Admin-123!';

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
  const adminRole = await prisma.role.findFirstOrThrow({
    where: { tenantId: tenant.id, name: 'TENANT_ADMIN' },
  });

  const hashedPassword = await hash(password, { algorithm: 2 });

  let user = await prisma.user.findFirst({ where: { tenantId: tenant.id, email } });
  if (user) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { hashedPassword, status: 'ACTIVE' },
    });
    console.log('Updated existing user.');
  } else {
    user = await prisma.user.create({
      data: { tenantId: tenant.id, email, hashedPassword, status: 'ACTIVE' },
    });
    console.log('Created new user.');
  }

  const existingLink = await prisma.userRole.findUnique({
    where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
  });
  if (!existingLink) {
    await prisma.userRole.create({
      data: { tenantId: tenant.id, userId: user.id, roleId: adminRole.id },
    });
  }

  console.log('Tenant admin ready:');
  console.log('  Workspace (slug): ' + tenantSlug);
  console.log('  Email: ' + email);
  console.log('  Password: ' + password);
}

main().finally(() => prisma.$disconnect());
