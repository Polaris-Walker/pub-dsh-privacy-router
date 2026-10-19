import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_PRIVACY_POLICY = [
  'Treat personal data, credentials, local paths, unpublished source code,',
  'internal project details, and confidential business information as sensitive.',
  'Classify as public only when the complete request is both safe to send to an external cloud model',
  'and self-contained without private conversation history.',
].join(' ')

export const LOCAL_PROVIDER_ID = 'privacy-local'

export type CloudTools = 'none' | 'masked'
export type SensitiveRoute = 'local' | 'mask'
export type Mode = 'auto' | 'local' | 'mask' | 'cloud'

export interface ModelRef {
  provider: string
  model: string
}

export interface LocalEndpoint {
  baseUrl: string
  model: string
  apiKey: string
  contextWindow: number
  maxTokens: number
}

export interface RouterConfig {
  /** Local model used for sensitive work. `endpoint` is set when the router registers it itself. */
  local: ModelRef & { endpoint?: LocalEndpoint }
  classifier: ModelRef
  cloud: ModelRef
  cloudTools: CloudTools
  sensitiveRoute: SensitiveRoute
  defaultMode: Exclude<Mode, 'cloud' | 'mask'>
  privacyPolicy: string
  sensitiveTerms: string[]
  maxPromptBytes: number
  classifierMaxTokens: number
  cloudMaxTokens: number
  contextWindow: number
}

type Input = Record<string, unknown>

function requireObject(value: unknown, label: string): Input {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Input
}

function rejectUnknown(input: Input, label: string, known: string[]) {
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) throw new TypeError(`unknown ${label} key: ${key}`)
  }
}

function requireString(value: unknown, label: string, fallback?: string): string {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== 'string' || resolved.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return resolved.trim()
}

function requireStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw new TypeError(`${label} must be an array of non-empty strings`)
  }
  return value.map(item => (item as string).trim())
}

function requirePositiveInteger(value: unknown, label: string, fallback: number, maximum: number): number {
  const resolved = value === undefined ? fallback : value
  if (!Number.isSafeInteger(resolved) || (resolved as number) <= 0 || (resolved as number) > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`)
  }
  return resolved as number
}

function requireEnum<T extends string>(value: unknown, label: string, allowed: readonly T[], fallback: T): T {
  const resolved = value === undefined ? fallback : value
  if (!allowed.includes(resolved as T)) {
    throw new TypeError(`${label} must be one of ${allowed.join(', ')}`)
  }
  return resolved as T
}

function resolveModelRef(value: unknown, label: string, fallback: ModelRef): ModelRef {
  const input = requireObject(value, label)
  rejectUnknown(input, label, ['provider', 'model'])
  return {
    provider: requireString(input.provider, `${label}.provider`, fallback.provider),
    model: requireString(input.model, `${label}.model`, fallback.model),
  }
}

function resolveLocal(value: unknown): RouterConfig['local'] {
  const input = requireObject(value, 'local')
  rejectUnknown(input, 'local', ['provider', 'model', 'baseUrl', 'apiKey', 'contextWindow', 'maxTokens'])
  const model = requireString(input.model, 'local.model', 'qwen2.5:7b')
  if (input.provider !== undefined) {
    if (input.baseUrl !== undefined) throw new TypeError('local accepts either provider or baseUrl, not both')
    return { provider: requireString(input.provider, 'local.provider'), model }
  }
  return {
    provider: LOCAL_PROVIDER_ID,
    model,
    endpoint: {
      baseUrl: requireString(input.baseUrl, 'local.baseUrl', 'http://localhost:11434/v1'),
      model,
      apiKey: requireString(input.apiKey, 'local.apiKey', 'ollama'),
      contextWindow: requirePositiveInteger(input.contextWindow, 'local.contextWindow', 32_768, 2_097_152),
      maxTokens: requirePositiveInteger(input.maxTokens, 'local.maxTokens', 8_192, 262_144),
    },
  }
}

export function resolveConfig(value: unknown): RouterConfig {
  const input = requireObject(value, 'privacy router config')
  rejectUnknown(input, 'privacy router config', [
    'local',
    'classifier',
    'cloud',
    'cloudTools',
    'sensitiveRoute',
    'defaultMode',
    'privacyPolicy',
    'sensitiveTerms',
    'maxPromptBytes',
    'classifierMaxTokens',
    'cloudMaxTokens',
    'contextWindow',
  ])

  const local = resolveLocal(input.local)
  const privacyPolicy = requireString(input.privacyPolicy, 'privacyPolicy', DEFAULT_PRIVACY_POLICY)
  if (Buffer.byteLength(privacyPolicy) > 16_384) {
    throw new TypeError('privacyPolicy must be at most 16384 UTF-8 bytes')
  }

  const config: RouterConfig = {
    local,
    classifier: resolveModelRef(input.classifier, 'classifier', local),
    cloud: resolveModelRef(input.cloud, 'cloud', { provider: 'deepseek', model: 'deepseek-v4-flash' }),
    cloudTools: requireEnum(input.cloudTools, 'cloudTools', ['none', 'masked'] as const, 'none'),
    sensitiveRoute: requireEnum(input.sensitiveRoute, 'sensitiveRoute', ['local', 'mask'] as const, 'local'),
    defaultMode: requireEnum(input.defaultMode, 'defaultMode', ['auto', 'local'] as const, 'auto'),
    privacyPolicy,
    sensitiveTerms: requireStringArray(input.sensitiveTerms, 'sensitiveTerms'),
    maxPromptBytes: requirePositiveInteger(input.maxPromptBytes, 'maxPromptBytes', 32_768, 1_048_576),
    classifierMaxTokens: requirePositiveInteger(input.classifierMaxTokens, 'classifierMaxTokens', 512, 4_096),
    cloudMaxTokens: requirePositiveInteger(input.cloudMaxTokens, 'cloudMaxTokens', 8_192, 262_144),
    contextWindow: requirePositiveInteger(
      input.contextWindow,
      'contextWindow',
      local.endpoint?.contextWindow ?? 32_768,
      2_097_152,
    ),
  }
  if (config.cloud.provider === config.local.provider && config.cloud.model === config.local.model) {
    throw new TypeError('cloud and local must be different models')
  }
  return Object.freeze(config)
}

/**
 * Reads the user-level config only. A project-level file is deliberately not supported:
 * a cloned repository must not be able to weaken the privacy gate.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const path = env.PI_PRIVACY_ROUTER_CONFIG
    ?? join(env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'privacy-router.json')
  if (!existsSync(path)) return resolveConfig({})
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`privacy-router: cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return resolveConfig(parsed)
}
