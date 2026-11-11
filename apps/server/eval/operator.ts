import { generateText, LanguageModel } from "ai"
import { DesignPrompt } from "./prompts.js"

/** What the designer left the operator to answer when it paused. */
export interface OperatorTurn {
  /** The designer's latest plain text since the last user message, if any */
  text: string
  /** An ask_user question, if the pause was one */
  question: string | null
  /** The question's options */
  options: string[]
  /** Last tool result before the pause, when there was no text (e.g. the thrash guard) */
  lastToolResult: string | null
}

/** One recorded steer: what the designer asked and what the operator said. */
export interface Steer {
  /** Designer's text and question, abbreviated */
  asked: string
  /** Operator reply sent as the next user message */
  reply: string
}

const SYSTEM = `You play the operator in an evaluation of an AI agent (the "designer") that builds
data integrations for a water and climate data platform. You are a water and
sanitation data manager: competent and clear about what you want, but not a GIS
or software specialist.

You started the session with the request below. Your private notes record the
intent and scope decisions behind it. The designer must do the technical work
itself; the evaluation measures whether it can.

Rules:
- Answer as this operator would: approve a sound plan, pick among offered
  options, clarify what you want. One to three sentences.
- When the designer offers options and one fits, reply with that option's text
  exactly.
- Never supply technical knowledge: no URLs, hostnames, API names, dataset or
  product identifiers beyond those in your request, file formats, grid or
  projection details, code, or debugging advice. Your private notes are for
  judging whether a plan matches your intent, not for passing on. If the
  designer is stuck on a technical problem, tell it you cannot help with the
  technical side and to use its own judgement.
- If a plan contradicts your intent (wrong product, cadence, layer name, units,
  coverage), say what you want instead in plain terms.
- If asked to paste a credential, say you will not paste secrets in chat and
  that the designer should request them through the credentials form.
- Do not end the session or tell the designer to stop; if it asks whether to
  keep going on your request, say yes.

Reply with the message text only.`

/**
 * Simulated operator answering the designer's questions. One model, fixed
 * across candidates, so steering is comparable between them.
 */
export class Operator {
  private model: LanguageModel
  private prompt: DesignPrompt
  /** Steers so far, oldest first */
  readonly steers: Steer[] = []
  /** Tokens the operator used (not charged to the candidate) */
  tokens = 0

  /** Creates an operator for one prompt. */
  constructor(model: LanguageModel, prompt: DesignPrompt) {
    this.model = model
    this.prompt = prompt
  }

  /** Records a scripted reply (e.g. credentials saved) as a steer. */
  record(asked: string, reply: string): void {
    this.steers.push({ asked, reply })
  }

  /** Produces the operator's reply to a pause and records it. */
  async reply(turn: OperatorTurn): Promise<string> {
    const history = this.steers.length
      ? `Earlier in this session you replied:\n${this.steers.map((s, i) => `${i + 1}. Designer: ${s.asked}\n   You: ${s.reply}`).join("\n")}\n\n`
      : ""
    const parts: string[] = []
    if (turn.text) parts.push(`The designer wrote:\n${turn.text}`)
    if (turn.question) {
      parts.push(`The designer asks:\n${turn.question}`)
      if (turn.options.length) parts.push(`Options:\n${turn.options.map(o => `- ${o}`).join("\n")}`)
    }
    if (!turn.text && !turn.question) {
      parts.push(
        turn.lastToolResult
          ? `The designer paused without a message. Its last tool result was:\n${turn.lastToolResult.slice(0, 3000)}`
          : "The designer paused without a message or question."
      )
    }
    const result = await generateText({
      model: this.model,
      system: SYSTEM,
      prompt: `Your request:\n${this.prompt.prompt}\n\nYour private notes:\n${this.prompt.scope}\n\n${history}${parts.join("\n\n")}\n\nYour reply:`,
      maxOutputTokens: 4000
    })
    this.tokens += (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0)
    const reply = result.text.trim() || "Please continue with what you think is best."
    const asked = [turn.question ?? "", turn.text].filter(Boolean).join(" | ") || "(paused silently)"
    this.steers.push({ asked: asked.replace(/\s+/g, " ").slice(0, 300), reply })
    return reply
  }
}
