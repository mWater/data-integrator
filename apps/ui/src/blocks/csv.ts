/** Client-side CSV download for assistant table blocks. */

/** One CSV field, quoted when it contains a delimiter, quote, or newline. */
function field(value: unknown): string {
  if (value == null) return ""
  const text = typeof value === "object" ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Builds a CSV from a result and triggers a browser download. */
export function downloadCsv(filename: string, columns: string[], rows: Record<string, unknown>[]): void {
  const lines = [columns.map(field).join(",")]
  for (const row of rows) lines.push(columns.map(c => field(row[c])).join(","))
  // BOM so spreadsheet apps detect UTF-8
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
