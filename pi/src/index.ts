import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import { loadConfig, type Mode, type RouterConfig } from './config.ts'
import { createPrivacyRouter, type Decision, type RegistryLike } from './router.ts'

export const PROVIDER_ID = 'privacy-router'
export const MODEL_ID = 'auto'
const ENTRY_TYPE = 'privacy-router'
const STATUS_KEY = 'privacy'
const MODES: Mode[] = ['auto', 'local', 'mask', 'cloud']

const ROUTE_LABEL: Record<Decision['route'], string> = {
  local: '🔒 local',
  cloud: '☁️ cloud',
  'masked-cloud': '🎭 masked→cloud',
}

/** What is written to the session: routing metadata only, never prompt text or entities. */
function auditEntry(decision: Decision) {
  return {
    turnKey: decision.turnKey,
    route: decision.route,
    classification: decision.classification,
    method: decision.method,
    mode: decision.mode,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    provider: decision.provider,
    model: decision.model,
    durationMs: decision.durationMs,
    maskedEntities: decision.entities.length,
  }
}

export function createExtension(config: RouterConfig) {
  return function privacyRouterExtension(pi: ExtensionAPI) {
    let ctx: ExtensionContext | undefined
    let pendingAudit: Decision[] = []

    const router = createPrivacyRouter(config, {
      getRegistry: () => ctx?.modelRegistry as RegistryLike | undefined,
      onDecision: decision => {
        pendingAudit.push(decision)
        ctx?.ui.setStatus(STATUS_KEY, `${ROUTE_LABEL[decision.route]} · ${decision.classification}`)
      },
    })

    const modeStatus = () => router.pending === undefined
      ? `privacy: ${router.mode}`
      : `privacy: ${router.mode} (next turn: ${router.pending})`

    const track = (next: ExtensionContext) => {
      ctx = next
    }

    if (config.local.endpoint !== undefined) {
      const endpoint = config.local.endpoint
      pi.registerProvider(config.local.provider, {
        name: 'Privacy Router local model',
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        api: 'openai-completions',
        models: [{
          id: endpoint.model,
          name: `${endpoint.model} (local)`,
          reasoning: false,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: endpoint.contextWindow,
          maxTokens: endpoint.maxTokens,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        }],
      })
    }

    pi.registerProvider(PROVIDER_ID, {
      name: 'Privacy Router',
      baseUrl: 'privacy-router://local',
      apiKey: 'privacy-router',
      api: 'privacy-router',
      models: [{
        id: MODEL_ID,
        name: 'Privacy Router (local ⇄ cloud)',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow,
        maxTokens: config.cloudMaxTokens,
      }],
      streamSimple: router.streamSimple,
    })

    pi.on('session_start', (_event, next) => {
      track(next)
      const restored = next.sessionManager.getBranch().flatMap(entry =>
        entry.type === 'custom' && entry.customType === ENTRY_TYPE
          && typeof (entry.data as Decision | undefined)?.turnKey === 'string'
          ? [entry.data as Pick<Decision, 'turnKey' | 'route'>]
          : [])
      router.reset(restored)
      pendingAudit = []
      next.ui.setStatus(STATUS_KEY, modeStatus())
    })
    pi.on('before_agent_start', (_event, next) => track(next))
    pi.on('turn_start', (_event, next) => track(next))
    pi.on('turn_end', (_event, next) => {
      track(next)
      for (const decision of pendingAudit) pi.appendEntry(ENTRY_TYPE, auditEntry(decision))
      pendingAudit = []
    })
    pi.on('model_select', (event, next) => {
      track(next)
      const id = `${event.model.provider}/${event.model.id}`
      if (event.model.provider !== PROVIDER_ID && event.model.provider !== config.local.provider) {
        next.ui.notify(`privacy-router: ${id} bypasses the privacy gate; select ${PROVIDER_ID}/${MODEL_ID} to keep it on`, 'warning')
      }
    })

    pi.registerCommand('privacy', {
      description: 'Privacy gate: /privacy [auto|local|mask|cloud] [sticky] | /privacy retry <local|mask|cloud>',
      getArgumentCompletions: prefix => {
        const items = [...MODES, 'retry cloud', 'retry mask', 'retry local']
          .filter(item => item.startsWith(prefix))
          .map(item => ({ value: item, label: item }))
        return items.length > 0 ? items : null
      },
      handler: async (args, next) => {
        track(next)
        const [first, second] = args.trim().split(/\s+/).filter(Boolean)
        if (first === undefined) {
          next.ui.notify([
            modeStatus(),
            `local: ${config.local.provider}/${config.local.model}`,
            `cloud: ${config.cloud.provider}/${config.cloud.model} (tools: ${config.cloudTools})`,
            `sensitive → ${config.sensitiveRoute}`,
          ].join('\n'), 'info')
          return
        }
        if (first === 'retry') {
          const target = second as Mode | undefined
          if (target === undefined || !MODES.includes(target)) {
            next.ui.notify('usage: /privacy retry <local|mask|cloud>', 'error')
            return
          }
          const prompt = router.lastPrompt
          if (prompt === undefined) {
            next.ui.notify('privacy-router: nothing to retry yet', 'warning')
            return
          }
          if (!next.isIdle()) {
            next.ui.notify('privacy-router: wait for the current turn to finish', 'warning')
            return
          }
          router.setOnce(target)
          pi.sendUserMessage(prompt)
          return
        }
        if (!MODES.includes(first as Mode)) {
          next.ui.notify(`privacy-router: unknown mode ${first}`, 'error')
          return
        }
        router.setMode(first as Mode, second === 'sticky')
        next.ui.setStatus(STATUS_KEY, modeStatus())
        next.ui.notify(modeStatus(), 'info')
      },
    })
  }
}

export default function (pi: ExtensionAPI) {
  createExtension(loadConfig())(pi)
}
