import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import pg from "pg"

/** AES-256-GCM layout inside the bytea value: iv (12) + tag (16) + ciphertext. */
const IV_LENGTH = 12
const TAG_LENGTH = 16

/**
 * Parses the 32-byte encryption key from INTEGRATOR_SECRET_KEY (base64 or hex).
 */
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

/** Shape of a secret name: what definitions may declare and routes accept. */
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Shortest secret value masked in job output; shorter values would mask ordinary text. */
export const MIN_REDACTED_SECRET_LENGTH = 6

/**
 * Builds a function that masks every secret value in text as
 * `[secret:<name>]`. Integration code can print a credential by accident, so
 * job output is masked on the host before it reaches stored logs, run
 * errors, live log streams, or the agent's context. Covers the literal value
 * only, not encodings of it.
 */
export function secretRedactor(secrets: Record<string, string>): (text: string) => string {
  // Longest first, so a value containing another is masked whole
  const entries = Object.entries(secrets)
    .filter(([, value]) => value.length >= MIN_REDACTED_SECRET_LENGTH)
    .sort((a, b) => b[1].length - a[1].length)
  if (entries.length === 0) return text => text
  return text => {
    let masked = text
    for (const [name, value] of entries) masked = masked.split(value).join(`[secret:${name}]`)
    return masked
  }
}

/** Stores (upserts) one integration's secret value under a name. */
export async function setSecret(
  pool: pg.Pool,
  key: Buffer,
  integrationId: string,
  name: string,
  value: string
): Promise<void> {
  await pool.query(
    `INSERT INTO app.integration_secrets (integration_id, name, value) VALUES ($1, $2, $3)
     ON CONFLICT (integration_id, name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [integrationId, name, encryptSecret(key, value)]
  )
}

/**
 * Fetches and decrypts the named secrets belonging to one integration.
 * Missing names are an error: only the owning integration's values are
 * visible, so a definition declaring another integration's secret name
 * fails here rather than receiving its credential.
 */
export async function getSecrets(
  pool: pg.Pool,
  key: Buffer,
  integrationId: string,
  names: string[]
): Promise<Record<string, string>> {
  if (names.length === 0) return {}
  const result = await pool.query(
    "SELECT name, value FROM app.integration_secrets WHERE integration_id = $1 AND name = ANY($2)",
    [integrationId, names]
  )
  const found = new Map(result.rows.map(r => [r.name as string, r.value as Buffer]))
  const secrets: Record<string, string> = {}
  for (const name of names) {
    const stored = found.get(name)
    if (!stored) throw new Error(`Secret ${name} is not set for this integration`)
    secrets[name] = decryptSecret(key, stored)
  }
  return secrets
}

/** A stored secret's public face: its name and when it last changed. */
export interface SecretInfo {
  /** The name the definition references */
  name: string
  /** Owning integration */
  integrationId: string
  /** Last set or replaced, ISO 8601 */
  updatedAt: string
}

/** Lists an integration's secret names and update times; never values. */
export async function listSecrets(pool: pg.Pool, integrationId: string): Promise<SecretInfo[]> {
  const result = await pool.query(
    "SELECT name, updated_at FROM app.integration_secrets WHERE integration_id = $1 ORDER BY name",
    [integrationId]
  )
  return result.rows.map(row => ({ name: row.name, integrationId, updatedAt: row.updated_at.toISOString() }))
}

/** Lists every integration's secret names, for the deployment-wide view. */
export async function listAllSecrets(pool: pg.Pool): Promise<SecretInfo[]> {
  const result = await pool.query(
    "SELECT integration_id, name, updated_at FROM app.integration_secrets ORDER BY integration_id, name"
  )
  return result.rows.map(row => ({
    name: row.name,
    integrationId: row.integration_id,
    updatedAt: row.updated_at.toISOString()
  }))
}

/** Deletes one integration's secret; returns false when it did not exist. */
export async function deleteSecret(pool: pg.Pool, integrationId: string, name: string): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM app.integration_secrets WHERE integration_id = $1 AND name = $2",
    [integrationId, name]
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Copies a secret value from another integration without the plaintext ever
 * leaving the server. The value is re-encrypted so each row keeps its own
 * envelope.
 */
export async function copySecret(
  pool: pg.Pool,
  key: Buffer,
  fromIntegrationId: string,
  toIntegrationId: string,
  name: string
): Promise<boolean> {
  const source = await pool.query(
    "SELECT value FROM app.integration_secrets WHERE integration_id = $1 AND name = $2",
    [fromIntegrationId, name]
  )
  if (source.rows.length === 0) return false
  await setSecret(pool, key, toIntegrationId, name, decryptSecret(key, source.rows[0].value))
  return true
}
