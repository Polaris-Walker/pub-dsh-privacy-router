export type FindingClass = 'secret' | 'pii' | 'term' | 'entity'

export interface Finding {
  id: string
  /** Placeholder category, e.g. SECRET, EMAIL, HOME. */
  type: string
  class: FindingClass
  start: number
  end: number
  text: string
}

interface Rule {
  id: string
  type: string
  class: FindingClass
  pattern: RegExp
  /** Capture group holding the value to mask; the whole match when omitted. */
  group?: number
}

// Secrets are masked on every cloud dispatch. PII is masked whenever the dispatch is masked.
const RULES: Rule[] = [
  {
    id: 'private-key',
    type: 'SECRET',
    class: 'secret',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi,
  },
  { id: 'bearer-token', type: 'SECRET', class: 'secret', pattern: /\bbearer\s+([A-Za-z0-9._~+/=-]{12,})/gi, group: 1 },
  {
    id: 'assigned-secret',
    type: 'SECRET',
    class: 'secret',
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\b\s*[:=]\s*["']?([^\s"',;]{6,})/gi,
    group: 1,
  },
  { id: 'openai-key', type: 'SECRET', class: 'secret', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'github-token', type: 'SECRET', class: 'secret', pattern: /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/gi },
  { id: 'aws-access-key', type: 'SECRET', class: 'secret', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'email', type: 'EMAIL', class: 'pii', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { id: 'cn-phone', type: 'PHONE', class: 'pii', pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g },
  { id: 'us-phone', type: 'PHONE', class: 'pii', pattern: /(?<![\d-])(?:\+?1[-. ]?)?(?:\(\d{3}\)|\d{3})[-. ]\d{3}[-. ]\d{4}(?![\d-])/g },
  // Only the home directory (which names the user) is masked, so relative structure stays usable.
  { id: 'local-path', type: 'HOME', class: 'pii', pattern: /(?:\/Users\/|\/home\/)[^\s/'"`<>|:;,)]+|[A-Z]:\\Users\\[^\s\\'"`<>|:;,)]+/gi },
]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function findLiteral(text: string, needle: string, type: string, cls: FindingClass, id: string): Finding[] {
  if (needle.length === 0) return []
  const findings: Finding[] = []
  const pattern = new RegExp(escapeRegExp(needle), 'gi')
  for (const match of text.matchAll(pattern)) {
    findings.push({ id, type, class: cls, start: match.index, end: match.index + match[0].length, text: match[0] })
  }
  return findings
}

export function detect(text: string, sensitiveTerms: readonly string[]): Finding[] {
  const findings: Finding[] = []
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = rule.group === undefined ? match[0] : match[rule.group]
      if (value === undefined || value.length === 0) continue
      const start = match.index + (rule.group === undefined ? 0 : match[0].indexOf(value))
      findings.push({ id: rule.id, type: rule.type, class: rule.class, start, end: start + value.length, text: value })
    }
  }
  for (const term of sensitiveTerms) {
    findings.push(...findLiteral(text, term, 'TERM', 'term', 'configured-sensitive-term'))
  }
  return findings
}

/** Keeps the earliest, then longest, finding wherever findings overlap. */
export function selectNonOverlapping(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort((left, right) =>
    left.start - right.start || (right.end - right.start) - (left.end - left.start))
  const selected: Finding[] = []
  let cursor = 0
  for (const finding of sorted) {
    if (finding.start < cursor) continue
    selected.push(finding)
    cursor = finding.end
  }
  return selected
}
