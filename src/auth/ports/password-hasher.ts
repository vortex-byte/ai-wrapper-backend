/** Password hashing port (consumer: auth application). Implemented with Bun.password. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}
