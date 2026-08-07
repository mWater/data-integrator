import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import pg from "pg"

/** AES-256-GCM layout inside the bytea value: iv (12) + tag (16) + ciphertext. */
const IV_LENGTH = 12
const TAG_LENGTH = 16

/** Parses the 32-byte encryption key from INTEGRATOR_SECRET_KEY (base64 or hex). */
export function loadSecretKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.INTEGRATOR_SECRET_KEY
  if (!raw) throw new Error("INTEGRATOR_SECRET_KEY is required")
  const key = raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64")
  if (key.length !== 32) throw new Error("INTEGRATOR_SECRET_KEY must be 32 bytes (base64 or hex)")
  return key
}

/** Encrypts a secret value for storage. */
export function encryptSecret(key: Buffer, value: string): Buffer {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

/** Decrypts a stored secret value. */
export function decryptSecret(key: Buffer, stored: Buffer): string {
  const iv = stored.subarray(0, IV_LENGTH)
  const tag = stored.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = stored.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}

/** Stores (upserts) a secret value under a name. */
export async function setSecret(pool: pg.Pool, key: Buffer, name: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO app.secrets (name, value) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [name, encryptSecret(key, value)]
  )
}

/** Fetches and decrypts the named secrets; missing names are an error. */
export async function getSecrets(pool: pg.Pool, key: Buffer, names: string[]): Promise<Record<string, string>> {
  if (names.length === 0) return {}
  const result = await pool.query("SELECT name, value FROM app.secrets WHERE name = ANY($1)", [names])
  const found = new Map(result.rows.map(r => [r.name as string, r.value as Buffer]))
  const secrets: Record<string, string> = {}
  for (const name of names) {
    const stored = found.get(name)
    if (!stored) throw new Error(`Secret ${name} is not set`)
    secrets[name] = decryptSecret(key, stored)
  }
  return secrets
}
