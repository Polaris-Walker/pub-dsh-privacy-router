import type { Message, TextContent, ToolCall } from '@mariozechner/pi-ai'
import { detect, findLiteral, selectNonOverlapping, type Finding } from './rules.ts'

const PLACEHOLDER_PATTERN = /⟦[A-Z]+_\d+⟧/g
const PLACEHOLDER_OPEN = '⟦'
const MAX_PLACEHOLDER_LENGTH = 32

export type MaskLevel = 'secrets' | 'full'

export function isPlaceholder(text: string): boolean {
  return /^⟦[A-Z]+_\d+⟧$/.test(text)
}

/**
 * Session-scoped mapping between sensitive originals and stable placeholders.
 * The mapping never leaves the process; only placeholders are sent to the cloud.
 */
export class MaskVault {
  private readonly byOriginal = new Map<string, string>()
  private readonly byPlaceholder = new Map<string, string>()
  private readonly counters = new Map<string, number>()

  get size(): number {
    return this.byOriginal.size
  }

  placeholderFor(original: string, type: string): string {
    const existing = this.byOriginal.get(original)
    if (existing !== undefined) return existing
    const next = (this.counters.get(type) ?? 0) + 1
    this.counters.set(type, next)
    const placeholder = `⟦${type}_${next}⟧`
    this.byOriginal.set(original, placeholder)
    this.byPlaceholder.set(placeholder, original)
    return placeholder
  }

  /** Every value masked once is masked in all later cloud dispatches, whatever their level. */
  knownFindings(text: string): Finding[] {
    const findings: Finding[] = []
    for (const [original, placeholder] of this.byOriginal) {
      const type = placeholder.slice(1, placeholder.lastIndexOf('_'))
      for (const finding of findLiteral(text, original, type, 'entity', 'known')) {
        if (finding.text === original) findings.push(finding)
      }
    }
    return findings
  }

  mask(text: string, findings: Finding[]): string {
    const protectedSpans = [...text.matchAll(PLACEHOLDER_PATTERN)]
      .map(match => [match.index, match.index + match[0].length] as const)
    const usable = findings.filter(finding =>
      !protectedSpans.some(([start, end]) => finding.start < end && finding.end > start))
    let output = ''
    let cursor = 0
    for (const finding of selectNonOverlapping(usable)) {
      output += text.slice(cursor, finding.start) + this.placeholderFor(finding.text, finding.type)
      cursor = finding.end
    }
    return output + text.slice(cursor)
  }

  unmask(text: string): string {
    return text.replace(PLACEHOLDER_PATTERN, placeholder => this.byPlaceholder.get(placeholder) ?? placeholder)
  }

  unmaskDeep<T>(value: T): T {
    if (typeof value === 'string') return this.unmask(value) as T
    if (Array.isArray(value)) return value.map(item => this.unmaskDeep(item)) as T
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.unmaskDeep(item)]),
      ) as T
    }
    return value
  }
}

export interface MaskOptions {
  level: MaskLevel
  sensitiveTerms: readonly string[]
  /** Extra literal values for this dispatch, such as entities reported by the local classifier. */
  entities?: readonly string[]
}

export function maskText(vault: MaskVault, text: string, options: MaskOptions): string {
  for (const entity of options.entities ?? []) {
    if (entity.length > 1 && text.includes(entity)) vault.placeholderFor(entity, 'PRIVATE')
  }
  const findings = detect(text, options.sensitiveTerms)
    .filter(finding => options.level === 'full' || finding.class === 'secret')
  return vault.mask(text, [...findings, ...vault.knownFindings(text)])
}

function maskDeep<T>(vault: MaskVault, value: T, options: MaskOptions): T {
  if (typeof value === 'string') return maskText(vault, value, options) as T
  if (Array.isArray(value)) return value.map(item => maskDeep(vault, item, options)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskDeep(vault, item, options)]),
    ) as T
  }
  return value
}

const WITHHELD_IMAGE = { type: 'text' as const, text: '[image withheld by privacy router]' }

/**
 * Projects a message for the cloud: text and tool arguments are masked, images and
 * thinking are dropped. Returns undefined when nothing remains to send.
 */
export function maskMessage(vault: MaskVault, message: Message, options: MaskOptions): Message | undefined {
  if (message.role === 'user') {
    const content = typeof message.content === 'string'
      ? [{ type: 'text' as const, text: message.content }]
      : message.content
    return {
      ...message,
      content: content.map(block => block.type === 'text'
        ? { type: 'text' as const, text: maskText(vault, block.text, options) }
        : WITHHELD_IMAGE),
    }
  }
  if (message.role === 'toolResult') {
    return {
      ...message,
      content: message.content.map(block => block.type === 'text'
        ? { type: 'text' as const, text: maskText(vault, block.text, options) }
        : WITHHELD_IMAGE),
      details: undefined,
    }
  }
  const content = message.content.flatMap((block): Array<TextContent | ToolCall> => {
    if (block.type === 'text') return [{ type: 'text', text: maskText(vault, block.text, options) }]
    if (block.type === 'toolCall') {
      return [{ type: 'toolCall', id: block.id, name: block.name, arguments: maskDeep(vault, block.arguments, options) }]
    }
    return []
  })
  return content.length === 0 ? undefined : { ...message, content }
}

/**
 * Unmasks a streamed text block incrementally. A trailing fragment that may be the start
 * of a placeholder is held back until it completes or clearly is not one.
 */
export class StreamUnmasker {
  private pending = ''
  private readonly vault: MaskVault

  constructor(vault: MaskVault) {
    this.vault = vault
  }

  push(delta: string): string {
    this.pending += delta
    const open = this.pending.lastIndexOf(PLACEHOLDER_OPEN)
    const holdFrom = open !== -1
      && !this.pending.includes('⟧', open)
      && this.pending.length - open < MAX_PLACEHOLDER_LENGTH
      ? open
      : this.pending.length
    const ready = this.pending.slice(0, holdFrom)
    this.pending = this.pending.slice(holdFrom)
    return this.vault.unmask(ready)
  }

  flush(): string {
    const rest = this.vault.unmask(this.pending)
    this.pending = ''
    return rest
  }
}
