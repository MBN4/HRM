import { z } from 'zod';

/**
 * `Idempotency-Key` header format — a client-generated opaque token
 * (typically a UUID), not interpreted, just used as a Redis key suffix by
 * `IdempotencyService`. See /CLAUDE.md § Conventions → Idempotency.
 */
export const idempotencyKeySchema = z.string().min(8).max(255);
