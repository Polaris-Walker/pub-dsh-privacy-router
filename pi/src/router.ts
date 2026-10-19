import { createHash } from 'node:crypto'
import {
  createAssistantMessageEventStream,
  streamSimple as piStreamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
} from '@mariozechner/pi-ai'
import { classifyLocally, type Classification, type ClassifierResult, type ContextEntry } from './classifier.ts'
import type { Mode, ModelRef, RouterConfig } from './config.ts'
import { isPlaceholder, MaskVault, maskMessage, maskText, StreamUnmasker, type MaskLevel } from './masking.ts'
import { detect } from './rules.ts'

export type Route = 'local' | 'cloud' | 'masked-cloud'
export type Method = 'deterministic' | 'model' | 'fallback' | 'manual'

export interface Decision {
  turnKey: string
  route: Route
  classification: Classification
  method: Method
  mode: Mode
  reason?: string
  /** Classifier entities; kept in memory only and never written to the session. */
  entities: string[]
  provider: string
  model: string
  durationMs: number
  classifier?: Pick<ClassifierResult, 'finish' | 'output' | 'error'>
}

/** The subset of Pi's ModelRegistry the router needs. */
export interface RegistryLike {
  find(provider: string, modelId: string): Model<Api> | undefined
  getApiKeyAndHeaders(model: Model<Api>): Promise<
    { ok: true, apiKey?: string, headers?: Record<string, string> } | { ok: false, error: string }
  >
}

export interface RouterDeps {
  getRegistry(): RegistryLike | undefined
  onDecision?(decision: Decision): void
}

const CLOUD_SYSTEM_PROMPT = [
  'Answer the user request directly.',
  'The request and any included conversation history are approved public content.',
  'Do not assume access to local files, tools, private project context, or omitted conversation history.',
].join(' ')

const PLACEHOLDER_NOTE = [
  'Some values are replaced by placeholders such as ⟦PRIVATE_1⟧ or ⟦HOME_1⟧ for privacy.',
  'Treat each placeholder as an opaque value and copy it verbatim wherever you need that value;',
  'never guess, expand or alter it.',
].join(' ')

const SUMMARY_PROMPT_PREFIX = 'You are a context summarization assistant.'

interface Turn {
  key?: string
  start: number
  userEnd: number
  end: number
}

function messageText(message: Message): string {
  if (message.role === 'user') {
    return typeof message.content === 'string'
      ? message.content
      : message.content.map(block => block.type === 'text' ? block.text : '[image]').join('\n')
  }
  if (message.role === 'toolResult') {
    const text = message.content.map(block => block.type === 'text' ? block.text : '[image]').join('\n')
    return `[tool-result ${message.toolName}${message.isError ? ' error' : ''}] ${text}`
  }
  return message.content.map(block => block.type === 'text'
    ? block.text
    : block.type === 'toolCall' ? `[tool-call ${block.name}] ${JSON.stringify(block.arguments)}` : '').filter(Boolean).join('\n')
}

/** A turn is a run of user messages followed by the assistant and tool messages it caused. */
export function splitTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  let index = 0
  while (index < messages.length) {
    const start = index
    while (index < messages.length && messages[index]!.role === 'user') index += 1
    const userEnd = index
    while (index < messages.length && messages[index]!.role !== 'user') index += 1
    const users = messages.slice(start, userEnd)
    turns.push({
      ...(users.length === 0
        ? {}
        : {
          key: createHash('sha256')
            .update(JSON.stringify(users.map(message => [message.timestamp, messageText(message)])))
            .digest('hex')
            .slice(0, 24),
        }),
      start,
      userEnd,
      end: index,
    })
  }
  return turns
}

function isCloudRoute(route: Route | undefined): boolean {
  return route === 'cloud' || route === 'masked-cloud'
}

function errorMessage(model: Model<Api>, message: string, aborted = false): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: message,
    timestamp: Date.now(),
  }
}

function linkedAbort(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (signal?.aborted) controller.abort(signal.reason)
  signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  return controller
}

/** Relays a cloud stream, restoring placeholders in text, thinking and tool-call arguments. */
async function relayUnmasked(
  inner: AssistantMessageEventStream,
  outer: AssistantMessageEventStream,
  vault: MaskVault,
  options: { rejectToolCalls: boolean, abort: AbortController, model: Model<Api> },
) {
  let output: AssistantMessage | undefined
  const unmaskers = new Map<number, StreamUnmasker>()
  const sync = (partial: AssistantMessage): AssistantMessage => {
    const { content: _content, ...meta } = partial
    output = output === undefined ? { ...meta, content: [] } : Object.assign(output, meta, { content: output.content })
    return output
  }
  const textual = (event: Extract<AssistantMessageEvent, { delta: string }>, field: 'text' | 'thinking') => {
    const current = sync(event.partial)
    const unmasker = unmaskers.get(event.contentIndex) ?? new StreamUnmasker(vault)
    unmaskers.set(event.contentIndex, unmasker)
    const delta = unmasker.push(event.delta)
    const block = current.content[event.contentIndex] as unknown as Record<string, string> | undefined
    if (block === undefined || delta.length === 0) return
    block[field] += delta
    outer.push({ ...event, delta, partial: current } as AssistantMessageEvent)
  }
  const finishTextual = (contentIndex: number, final: string, field: 'text' | 'thinking', type: 'text_delta' | 'thinking_delta') => {
    const current = output!
    const block = current.content[contentIndex] as unknown as Record<string, string> | undefined
    const rest = unmaskers.get(contentIndex)?.flush() ?? ''
    if (block !== undefined && rest.length > 0) {
      block[field] += rest
      outer.push({ type, contentIndex, delta: rest, partial: current } as AssistantMessageEvent)
    }
    if (block !== undefined) block[field] = vault.unmask(final)
    return block?.[field] ?? vault.unmask(final)
  }

  for await (const event of inner) {
    switch (event.type) {
      case 'start':
        outer.push({ type: 'start', partial: sync(event.partial) })
        break
      case 'text_start':
      case 'thinking_start': {
        const current = sync(event.partial)
        current.content[event.contentIndex] = event.type === 'text_start'
          ? { type: 'text', text: '' }
          : { type: 'thinking', thinking: '' }
        outer.push({ ...event, partial: current })
        break
      }
      case 'text_delta':
        textual(event, 'text')
        break
      case 'thinking_delta':
        textual(event, 'thinking')
        break
      case 'text_end': {
        sync(event.partial)
        const content = finishTextual(event.contentIndex, event.content, 'text', 'text_delta')
        outer.push({ ...event, content, partial: output! })
        break
      }
      case 'thinking_end': {
        sync(event.partial)
        const content = finishTextual(event.contentIndex, event.content, 'thinking', 'thinking_delta')
        outer.push({ ...event, content, partial: output! })
        break
      }
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end': {
        if (options.rejectToolCalls) {
          options.abort.abort()
          outer.push({
            type: 'error',
            reason: 'error',
            error: errorMessage(options.model, 'privacy-router: cloud responses cannot call local tools (cloudTools is "none")'),
          })
          return
        }
        const current = sync(event.partial)
        const block = event.partial.content[event.contentIndex]
        if (block !== undefined) current.content[event.contentIndex] = vault.unmaskDeep(block)
        if (event.type === 'toolcall_end') {
          const toolCall = vault.unmaskDeep(event.toolCall)
          current.content[event.contentIndex] = toolCall
          outer.push({ ...event, toolCall, partial: current })
        } else {
          outer.push({ ...event, partial: current })
        }
        break
      }
      case 'done':
        outer.push({ type: 'done', reason: event.reason, message: vault.unmaskDeep(event.message) })
        return
      case 'error':
        outer.push({ type: 'error', reason: event.reason, error: vault.unmaskDeep(event.error) })
        return
    }
  }
}

async function relay(inner: AssistantMessageEventStream, outer: AssistantMessageEventStream) {
  for await (const event of inner) outer.push(event)
}

export function createPrivacyRouter(config: RouterConfig, deps: RouterDeps) {
  let mode: Mode = config.defaultMode
  let once: Mode | undefined
  let decisions = new Map<string, Decision>()
  let vault = new MaskVault()
  let lastPrompt: string | undefined

  async function resolveModel(ref: ModelRef) {
    const registry = deps.getRegistry()
    if (registry === undefined) throw new Error('privacy-router: model registry is not ready yet')
    const model = registry.find(ref.provider, ref.model)
    if (model === undefined) {
      throw new Error(`privacy-router: model ${ref.provider}/${ref.model} is not configured in Pi`)
    }
    const auth = await registry.getApiKeyAndHeaders(model)
    if (!auth.ok) throw new Error(`privacy-router: ${ref.provider}/${ref.model}: ${auth.error}`)
    return { model, apiKey: auth.apiKey, headers: auth.headers }
  }

  function classifierContext(messages: Message[], turns: Turn[], candidateText: string) {
    const entries: ContextEntry[] = []
    let remaining = Math.max(0, config.maxPromptBytes - Buffer.byteLength(candidateText))
    let truncated = false
    outer: for (let index = turns.length - 2; index >= 0; index -= 1) {
      const turn = turns[index]!
      const cloudSafe = turn.key !== undefined && isCloudRoute(decisions.get(turn.key)?.route)
      for (let position = turn.end - 1; position >= turn.start; position -= 1) {
        const message = messages[position]!
        const entry = { role: message.role, cloudSafe, text: messageText(message) }
        const bytes = Buffer.byteLength(JSON.stringify(entry))
        if (bytes > remaining) {
          truncated = true
          break outer
        }
        entries.unshift(entry)
        remaining -= bytes
      }
    }
    return { entries, truncated }
  }

  /** The masked candidate must not trip any deterministic rule, or masking is incomplete. */
  function maskingHolds(text: string, entities: string[]): boolean {
    const masked = maskText(vault, text, { level: 'full', sensitiveTerms: config.sensitiveTerms, entities })
    // A rule may re-match around a placeholder (`password=⟦SECRET_1⟧`); only real values count.
    return detect(masked, config.sensitiveTerms).every(finding => isPlaceholder(finding.text))
      && entities.every(entity => !masked.includes(entity))
  }

  async function decide(
    messages: Message[],
    turns: Turn[],
    current: Turn,
    signal: AbortSignal | undefined,
  ): Promise<Omit<Decision, 'provider' | 'model' | 'durationMs' | 'turnKey' | 'mode'>> {
    const effective = once ?? mode
    const users = messages.slice(current.start, current.userEnd)
    const text = users.map(messageText).join('\n').trim()
    lastPrompt = text
    if (effective === 'local') return { route: 'local', classification: 'unknown', method: 'manual', entities: [] }
    if (effective === 'cloud') return { route: 'cloud', classification: 'unknown', method: 'manual', entities: [] }

    const hasImage = users.some(message => typeof message.content !== 'string'
      && message.content.some(block => block.type === 'image'))
    if (text.length === 0) return { route: 'local', classification: 'unknown', method: 'fallback', reason: 'empty-prompt', entities: [] }
    if (hasImage) return { route: 'local', classification: 'unknown', method: 'fallback', reason: 'non-text-input', entities: [] }
    if (Buffer.byteLength(text) > config.maxPromptBytes) {
      return { route: 'local', classification: 'unknown', method: 'fallback', reason: 'payload-too-large', entities: [] }
    }

    const findings = detect(text, config.sensitiveTerms)
    const wantMask = effective === 'mask' || config.sensitiveRoute === 'mask'
    if (findings.length > 0 && !wantMask) {
      return { route: 'local', classification: 'sensitive', method: 'deterministic', reason: findings[0]!.id, entities: [] }
    }

    let result: ClassifierResult
    try {
      const classifier = await resolveModel(config.classifier)
      const context = classifierContext(messages, turns, text)
      result = await classifyLocally(config, {
        text,
        context: context.entries,
        contextTruncated: context.truncated,
      }, { ...classifier, signal })
    } catch (error) {
      result = {
        classification: 'unknown',
        entities: [],
        maskable: false,
        finish: 'thrown',
        output: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }
    const classifier = {
      finish: result.finish,
      output: result.output,
      ...(result.error === undefined ? {} : { error: result.error }),
    }
    const classification: Classification = findings.length > 0 ? 'sensitive' : result.classification
    const method: Method = findings.length > 0 && result.classification === 'unknown' ? 'deterministic' : 'model'
    const base = {
      classification,
      method,
      entities: result.entities,
      classifier,
      ...(result.reason === undefined
        ? findings.length > 0 ? { reason: findings[0]!.id } : {}
        : { reason: result.reason }),
    }
    const classifierFailed = result.finish === 'thrown' || result.finish === 'error' || result.finish === 'aborted'
      || result.output.length === 0
    // Deterministic findings are maskable by construction; a model "public" verdict has nothing else to hide.
    const maskable = result.classification === 'public' || result.maskable

    if (effective === 'mask') {
      if (classifierFailed) return { ...base, route: 'local', reason: 'classifier-failed' }
      if (!maskingHolds(text, result.entities)) return { ...base, route: 'local', reason: 'mask-incomplete' }
      return { ...base, route: 'masked-cloud' }
    }
    if (classification === 'public') return { ...base, route: 'cloud' }
    if (classification === 'sensitive'
      && config.sensitiveRoute === 'mask'
      && !classifierFailed
      && maskable
      && (findings.length > 0 || result.entities.length > 0)
      && maskingHolds(text, result.entities)) {
      return { ...base, route: 'masked-cloud' }
    }
    return {
      ...base,
      route: 'local',
      ...(classification === 'unknown' && base.reason === undefined ? { reason: `classifier-${result.finish}` } : {}),
    }
  }

  function cloudContext(context: Context, turns: Turn[], current: Turn, decision: Decision): Context {
    const withTools = config.cloudTools === 'masked'
    const level: MaskLevel = decision.route === 'masked-cloud' || withTools ? 'full' : 'secrets'
    const options = { level, sensitiveTerms: config.sensitiveTerms, entities: decision.entities }
    const messages: Message[] = []
    for (const turn of turns) {
      const approved = turn === current
        || (turn.key !== undefined && isCloudRoute(decisions.get(turn.key)?.route))
      if (!approved) continue
      for (const message of context.messages.slice(turn.start, turn.end)) {
        let projected: Message | undefined = message
        if (!withTools) {
          if (message.role === 'toolResult') continue
          if (message.role === 'assistant') {
            projected = { ...message, content: message.content.filter(block => block.type === 'text') }
          }
        }
        const masked = maskMessage(vault, projected, options)
        if (masked !== undefined) messages.push(masked)
      }
    }
    const systemPrompt = withTools
      ? `${maskText(vault, context.systemPrompt ?? '', options)}\n\n${PLACEHOLDER_NOTE}`
      : `${CLOUD_SYSTEM_PROMPT} ${PLACEHOLDER_NOTE}`
    return { systemPrompt, messages, tools: withTools ? context.tools : [] }
  }

  async function run(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    outer: AssistantMessageEventStream,
  ) {
    // Pi's compaction and branch summaries serialise the whole conversation, local turns included.
    if (context.systemPrompt?.startsWith(SUMMARY_PROMPT_PREFIX)) {
      const local = await resolveModel(config.local)
      await relay(piStreamSimple(local.model, context, {
        ...options,
        apiKey: local.apiKey,
        headers: { ...options?.headers, ...local.headers },
        maxTokens: Math.min(options?.maxTokens ?? local.model.maxTokens, local.model.maxTokens),
      }), outer)
      return
    }

    const turns = splitTurns(context.messages)
    const current = turns.at(-1)
    if (current?.key === undefined) throw new Error('privacy-router: no user message to route')

    let decision = decisions.get(current.key)
    if (decision === undefined) {
      const startedAt = Date.now()
      const effective = once ?? mode
      const decided = await decide(context.messages, turns, current, options?.signal)
      once = undefined
      const target = isCloudRoute(decided.route) ? config.cloud : config.local
      decision = {
        ...decided,
        turnKey: current.key,
        mode: effective,
        provider: target.provider,
        model: target.model,
        durationMs: Math.max(0, Date.now() - startedAt),
      }
      decisions.set(current.key, decision)
      deps.onDecision?.(decision)
    }
    if (options?.signal?.aborted) {
      outer.push({ type: 'error', reason: 'aborted', error: errorMessage(model, 'aborted', true) })
      return
    }

    const cloud = isCloudRoute(decision.route)
    const target = await resolveModel(cloud ? config.cloud : config.local)
    const maxTokens = Math.min(
      options?.maxTokens ?? target.model.maxTokens,
      target.model.maxTokens,
      cloud ? config.cloudMaxTokens : target.model.maxTokens,
    )
    const abort = linkedAbort(options?.signal)
    const innerOptions: SimpleStreamOptions = {
      ...options,
      apiKey: target.apiKey,
      headers: { ...options?.headers, ...target.headers },
      maxTokens,
      signal: abort.signal,
    }
    if (!cloud) {
      await relay(piStreamSimple(target.model, context, innerOptions), outer)
      return
    }
    const inner = piStreamSimple(target.model, cloudContext(context, turns, current, decision), innerOptions)
    await relayUnmasked(inner, outer, vault, {
      rejectToolCalls: config.cloudTools === 'none',
      abort,
      model: target.model,
    })
  }

  return {
    get mode(): Mode {
      return mode
    },
    get pending(): Mode | undefined {
      return once
    },
    get lastPrompt(): string | undefined {
      return lastPrompt
    },
    /** `cloud` and `mask` default to the next turn only, so a forced release never lingers. */
    setMode(next: Mode, sticky = false) {
      if ((next === 'cloud' || next === 'mask') && !sticky) {
        once = next
      } else {
        mode = next
        once = undefined
      }
    },
    /** Applies a mode to the next new turn only. */
    setOnce(next: Mode) {
      once = next
    },
    /** Starts a fresh session state; only public cloud approvals may be restored. */
    reset(restored: Array<Pick<Decision, 'turnKey' | 'route'>> = []) {
      decisions = new Map()
      vault = new MaskVault()
      once = undefined
      lastPrompt = undefined
      for (const entry of restored) {
        if (entry.route !== 'cloud') continue
        decisions.set(entry.turnKey, {
          turnKey: entry.turnKey,
          route: 'cloud',
          classification: 'public',
          method: 'fallback',
          mode: 'auto',
          reason: 'restored',
          entities: [],
          provider: config.cloud.provider,
          model: config.cloud.model,
          durationMs: 0,
        })
      }
    },
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
      const outer = createAssistantMessageEventStream()
      run(model, context, options, outer)
        .catch(error => {
          outer.push({
            type: 'error',
            reason: options?.signal?.aborted ? 'aborted' : 'error',
            error: errorMessage(model, error instanceof Error ? error.message : String(error), options?.signal?.aborted),
          })
        })
        .finally(() => outer.end())
      return outer
    },
  }
}

export type PrivacyRouter = ReturnType<typeof createPrivacyRouter>
