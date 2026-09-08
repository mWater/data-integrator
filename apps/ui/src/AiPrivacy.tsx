/**
 * AI & data privacy page: exactly what the AI features send to the model
 * provider, what never leaves the deployment, and the self-hosting option.
 * Linked from the acknowledgement dialog; the facts here mirror the agent
 * implementations in apps/server/src/agent/.
 */

import { AiInfo } from "./api.js"
import { aiProviderName } from "./aiAck.js"

/** Props for the AI privacy page. */
interface AiPrivacyProps {
  /** The deployment's AI wiring, from /api/me */
  ai: AiInfo
}

/** Static explainer of how the AI features handle data. */
export function AiPrivacy({ ai }: AiPrivacyProps) {
  const provider = aiProviderName()
  return (
    <main className="list-page ai-privacy">
      <h1>{T`AI and Data Privacy`}</h1>

      <p>
        {T`Three features of this platform use a large language model: the integration designer, Explore (questions about the data), and the dashboard builder. Everything else - scheduled ingestion runs, webhooks, maps, tables, dashboards being viewed - involves no model and sends nothing anywhere.`}
      </p>

      <h2>{T`Where the model runs`}</h2>
      <p>
        {ai.provider === null
          ? T`No model is configured on this deployment, so the AI features are disabled and no data is sent to any model provider.`
          : ai.provider === "custom"
            ? T`This deployment is configured to use its own model endpoint, operated by your administrator. AI requests go to that endpoint, not to an external provider.`
            : T`This deployment uses ${provider} as its model provider. AI requests are sent to ${provider}'s API over an encrypted connection and processed there to generate responses. Retention and training commitments are governed by the provider's API terms; major providers do not use API traffic to train models by default.`}
      </p>

      <h2>{T`What is sent, and when`}</h2>
      <p>{T`Data is sent only while a person is actively using an AI feature. One request can include:`}</p>
      <ul>
        <li>{T`the messages you type`}</li>
        <li>{T`the data schema: table and column names, descriptions, and the deployment's area of interest`}</li>
        <li>{T`SQL the model writes, and samples of the rows those queries return`}</li>
        <li>{T`integration code, and log output from runs the designer starts while building or testing an integration`}</li>
      </ul>

      <h2>{T`What is never sent`}</h2>
      <ul>
        <li>{T`stored secret values (API keys, source credentials): they are encrypted at rest, write-only, and the agents can only reference them by name`}</li>
        <li>{T`user accounts and passwords`}</li>
        <li>{T`raster imagery files: the model sees derived statistics and log lines, not the pixels`}</li>
        <li>{T`anything from scheduled runs: cron and webhook ingestion never contacts the model provider`}</li>
      </ul>

      <h2>{T`Controls`}</h2>
      <ul>
        <li>{T`The AI features are off unless an administrator configures a model provider; a deployment without one runs fully AI-free.`}</li>
        <li>{T`With an external provider configured, each user must accept a one-time notice before their first AI use; the acceptance is recorded.`}</li>
        <li>{T`Administrators can instead point the platform at a self-hosted, OpenAI-compatible model endpoint so AI requests never leave their own infrastructure.`}</li>
      </ul>
    </main>
  )
}
