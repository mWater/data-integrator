/**
 * Human activity labels for tool calls: [while running, once done]. Built per
 * call rather than once at module load, so a locale change reaches them.
 */
function labels(): Record<string, [string, string]> {
  return {
    run_snippet: [T`Running code`, T`Ran code`],
    write_definition: [T`Updating the design`, T`Updated the design`],
    get_definition: [T`Reading the design`, T`Read the design`],
    edit_code: [T`Editing code`, T`Edited code`],
    query_table: [T`Checking data`, T`Checked data`],
    search_library: [T`Searching the library`, T`Searched the library`],
    read_skill: [T`Reading a source note`, T`Read a source note`],
    list_secrets: [T`Checking stored credentials`, T`Checked stored credentials`],
    finish: [T`Saving`, T`Saved`],
    get_dashboard: [T`Reading the draft`, T`Read the draft`],
    write_source: [T`Writing the dashboard`, T`Wrote the dashboard`],
    edit_source: [T`Editing the dashboard`, T`Edited the dashboard`],
    set_queries: [T`Updating queries`, T`Updated queries`],
    set_layers: [T`Choosing map layers`, T`Chose map layers`],
    ready_to_save: [T`Marking ready to save`, T`Marked ready to save`],
    sample_query: [T`Exploring data`, T`Explored data`],
    list_schema: [T`Reading the schema`, T`Read the schema`],
    query: [T`Investigating the data`, T`Investigated the data`],
    show_table: [T`Building a table`, T`Built a table`],
    show_chart: [T`Drawing a chart`, T`Drew a chart`],
    show_map: [T`Drawing a map`, T`Drew a map`],
    lookup_country: [T`Looking up a place`, T`Looked up a place`]
  }
}

/** Human-readable label for a tool call; raw tool names stay out of the UI. */
export function activityLabel(tool: string | undefined, input: unknown, running: boolean): string {
  if (tool === "run_integration") {
    const cold = (input as { cold?: boolean } | undefined)?.cold === true
    if (cold) return running ? T`Testing from a clean slate` : T`Tested from a clean slate`
    return running ? T`Testing the integration` : T`Tested the integration`
  }
  const pair = tool ? labels()[tool] : undefined
  if (pair) return running ? pair[0] : pair[1]
  return (tool ?? T`working`).replace(/_/g, " ")
}
