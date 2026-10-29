/**
 * Credentials panel for one integration: the secret names its definition
 * declares, whether each is set, and admin controls to set, replace, copy
 * from another integration, or delete a value. Values are write-only; the
 * server never returns them.
 */
import { useEffect, useMemo, useState } from "react"
import {
  copySecretValue,
  deleteSecretValue,
  listAllSecrets,
  listIntegrationSecrets,
  SecretInfo,
  setSecretValue
} from "./api.js"

/** Props for the secrets section. */
interface SecretsSectionProps {
  /** Integration whose secrets are managed */
  integrationId: string
  /** Secret names the definition declares */
  declared: string[]
  /** True for admins: enables editing */
  isAdmin: boolean
}

/** One integration's credentials: declared names, set state, admin editing. */
export function SecretsSection({ integrationId, declared, isAdmin }: SecretsSectionProps) {
  const [stored, setStored] = useState<SecretInfo[] | null>(null)
  const [elsewhere, setElsewhere] = useState<SecretInfo[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = () => {
    listIntegrationSecrets(integrationId).then(r => setStored(r.secrets), err => setError(err.message))
    if (isAdmin) {
      listAllSecrets().then(
        r => setElsewhere(r.secrets.filter(s => s.integrationId !== integrationId)),
        () => {}
      )
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [integrationId, isAdmin])

  // Declared names lead; stray stored values (renamed in the definition) trail
  const names = useMemo(() => {
    const extra = (stored ?? []).map(s => s.name).filter(n => !declared.includes(n))
    return [...declared, ...extra]
  }, [declared, stored])

  if (names.length === 0) return null
  const storedByName = new Map((stored ?? []).map(s => [s.name, s]))

  async function save(name: string) {
    setBusy(true)
    setError(null)
    try {
      await setSecretValue(integrationId, name, value)
      setEditing(null)
      setValue("")
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function copyFrom(name: string, fromIntegrationId: string) {
    setError(null)
    try {
      await copySecretValue(integrationId, name, fromIntegrationId)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function remove(name: string) {
    setError(null)
    try {
      await deleteSecretValue(integrationId, name)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="aoi-section">
      <h3>{T`Credentials`}</h3>
      <p className="dim">
        {T`Secret values are stored encrypted with this integration and are write-only: they can be replaced but never read back.`}
      </p>
      {error && <div className="error">{error}</div>}
      <table className="secrets-table">
        <tbody>
          {names.map(name => {
            const info = storedByName.get(name)
            const sources = elsewhere.filter(s => s.name === name)
            return (
              <tr key={name}>
                <td>
                  <code>{name}</code>
                  {!declared.includes(name) && <span className="dim"> {T`(not declared)`}</span>}
                </td>
                <td>
                  {info ? (
                    <span className="chip chip-succeeded">{T`set ${new Date(info.updatedAt).toLocaleDateString()}`}</span>
                  ) : (
                    <span className="chip chip-failed">{T`missing`}</span>
                  )}
                </td>
                {isAdmin && (
                  <td className="secrets-actions">
                    {editing === name ? (
                      <span className="secrets-editor">
                        <textarea
                          rows={2}
                          placeholder={T`Paste the value (plain text or JSON)`}
                          value={value}
                          onChange={e => setValue(e.target.value)}
                        />
                        <button disabled={busy || value.length === 0} onClick={() => save(name)}>
                          {T`Save`}
                        </button>
                        <button className="secondary" onClick={() => { setEditing(null); setValue("") }}>
                          {T`Cancel`}
                        </button>
                      </span>
                    ) : (
                      <>
                        <button className="secondary" onClick={() => { setEditing(name); setValue("") }}>
                          {info ? T`Replace` : T`Set`}
                        </button>
                        {!info && sources.length > 0 && (
                          <select
                            defaultValue=""
                            aria-label={T`Copy ${name} from another integration`}
                            onChange={e => e.target.value && copyFrom(name, e.target.value)}
                          >
                            <option value="" disabled>
                              {T`Copy from…`}
                            </option>
                            {sources.map(s => (
                              <option key={s.integrationId} value={s.integrationId}>
                                {s.integrationId}
                              </option>
                            ))}
                          </select>
                        )}
                        {info && (
                          <button className="danger" onClick={() => remove(name)}>
                            {T`Delete`}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
