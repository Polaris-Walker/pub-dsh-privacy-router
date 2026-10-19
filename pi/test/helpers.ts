import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
} from '@mariozechner/pi-ai'
import { resolveConfig, type RouterConfig } from '../src/config.ts'
import { createPrivacyRouter, type Decision, type RegistryLike } from '../src/router.ts'

export { fauxAssistantMessage, fauxToolCall }

export interface Harness {
  router: ReturnType<typeof createPrivacyRouter>
  config: RouterConfig
  local: ReturnType<typeof registerFauxProvider>
  cloud: ReturnType<typeof registerFauxProvider>
  /** Contexts each faux model received, in call order. */
  seen: { local: Context[], cloud: Context[] }
  decisions: Decision[]
  virtual: Model<Api>
  cleanup(): void
}

export function classifierReply(value: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage(JSON.stringify(value))
}

export function createHarness(input: Record<string, unknown> = {}): Harness {
  const local = registerFauxProvider({
    api: 'faux-local',
    provider: 'test-local',
    models: [{ id: 'small' }],
    tokenSize: { min: 1, max: 3 },
  })
  const cloud = registerFauxProvider({
    api: 'faux-cloud',
    provider: 'test-cloud',
    models: [{ id: 'big' }],
    tokenSize: { min: 1, max: 3 },
  })
  const config = resolveConfig({
    local: { provider: 'test-local', model: 'small' },
    cloud: { provider: 'test-cloud', model: 'big' },
    ...input,
  })
  const models = [local.getModel(), cloud.getModel()]
  const registry: RegistryLike = {
    find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' }),
  }
  const decisions: Decision[] = []
  const router = createPrivacyRouter(config, {
    getRegistry: () => registry,
    onDecision: decision => decisions.push(decision),
  })
  const seen = { local: [] as Context[], cloud: [] as Context[] }
  const virtual = { ...cloud.getModel(), provider: 'privacy-router', id: 'auto', api: 'privacy-router' } as Model<Api>
  return {
    router,
    config,
    local,
    cloud,
    seen,
    decisions,
    virtual,
    cleanup() {
      local.unregister()
      cloud.unregister()
    },
  }
}

/** Wraps a canned reply so the harness records the context the model was given. */
export function recording(sink: Context[], reply: AssistantMessage | ((context: Context) => AssistantMessage)) {
  return (context: Context) => {
    sink.push(structuredClone(context))
    return typeof reply === 'function' ? reply(context) : reply
  }
}

export function user(text: string, timestamp = Date.now()): Message {
  return { role: 'user', content: text, timestamp }
}

export async function run(harness: Harness, context: Context) {
  const stream = harness.router.streamSimple(harness.virtual, context, { maxTokens: 1024 })
  let streamed = ''
  const types: string[] = []
  for await (const event of stream) {
    types.push(event.type)
    if (event.type === 'text_delta') streamed += event.delta
  }
  const message = await stream.result()
  return { message, streamed, types }
}

export function textOf(message: AssistantMessage | Message): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

export function allText(context: Context): string {
  return [context.systemPrompt ?? '', ...context.messages.map(message => {
    if (message.role === 'assistant') {
      return message.content.map(block => block.type === 'text'
        ? block.text
        : block.type === 'toolCall' ? JSON.stringify(block.arguments) : '').join('\n')
    }
    return textOf(message)
  })].join('\n')
}
