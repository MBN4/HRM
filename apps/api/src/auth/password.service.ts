import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2's `Algorithm` is an ambient `const enum`, which
// `isolatedModules` (on for this whole repo — see packages/config) can't
// reference across files. `2` is `Algorithm.Argon2id` (also the library's
// own default, but pinned explicitly so a future upstream default change
// can't silently downgrade what we hash with).
const ARGON2ID = 2;

/** Thin wrapper around `@node-rs/argon2` (prebuilt native bindings, no node-gyp compile step). */
@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, { algorithm: ARGON2ID });
  }

  verify(hashed: string, plain: string): Promise<boolean> {
    return verify(hashed, plain);
  }
}
