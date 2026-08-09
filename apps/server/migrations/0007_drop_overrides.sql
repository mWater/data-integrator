-- The definition is the integration's single specification. The override
-- layer (deployment-local trigger/limits merged at run time) is removed: it
-- gave the agent and the UI different editing surfaces for the same fields,
-- with overrides silently shadowing definition edits. Library installs copy
-- entry defaults into the definition; updates carry deployment-owned fields
-- (aoi, trigger, limits) over from the installed definition.
ALTER TABLE app.integrations DROP COLUMN overrides;
