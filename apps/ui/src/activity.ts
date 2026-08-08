/** Human activity labels for tool calls: [while running, once done]. */
const LABELS: Record<string, [string, string]> = {
  run_snippet: ["Running code", "Ran code"],
  write_definition: ["Updating the design", "Updated the design"],
  get_definition: ["Reading the design", "Read the design"],
  edit_code: ["Editing code", "Edited code"],
  query_table: ["Checking data", "Checked data"],
  finish: ["Saving the integration", "Saved the integration"]
}

/** Human-readable label for a tool call; raw tool names stay out of the UI. */
export function activityLabel(tool: string | undefined, input: unknown, running: boolean): string {
  if (tool === "run_integration") {
    const cold = (input as { cold?: boolean } | undefined)?.cold === true
    if (cold) return running ? "Testing from a clean slate" : "Tested from a clean slate"
    return running ? "Testing the integration" : "Tested the integration"
  }
  const pair = tool ? LABELS[tool] : undefined
  if (pair) return running ? pair[0] : pair[1]
  return (tool ?? "working").replace(/_/g, " ")
}
