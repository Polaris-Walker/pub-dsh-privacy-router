import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClassifierOutput } from '../src/classifier.ts'
import { LOCAL_PROVIDER_ID, resolveConfig } from '../src/config.ts'
import { MaskVault, maskText, StreamUnmasker } from '../src/masking.ts'
import { detect } from '../src/rules.ts'

test('config defaults to local Ollama, cloud without tools, sensitive stays local', () => {
  const config = resolveConfig({})
  assert.equal(config.local.provider, LOCAL_PROVIDER_ID)
  assert.equal(config.local.endpoint?.baseUrl, 'http://localhost:11434/v1')
  assert.deepEqual(config.classifier, { provider: LOCAL_PROVIDER_ID, model: config.local.model })
  assert.equal(config.cloudTools, 'none')
  assert.equal(config.sensitiveRoute, 'local')
  assert.equal(config.defaultMode, 'auto')
})

test('config fails loud on unknown keys and ambiguous local settings', () => {
  assert.throws(() => resolveConfig({ cloudModel: 'x' }), /unknown privacy router config key: cloudModel/)
  assert.throws(() => resolveConfig({ local: { provider: 'ollama', baseUrl: 'http://x' } }), /either provider or baseUrl/)
  assert.throws(() => resolveConfig({ cloudTools: 'all' }), /cloudTools must be one of none, masked/)
  assert.throws(() => resolveConfig({ defaultMode: 'cloud' }), /defaultMode must be one of auto, local/)
  assert.throws(
    () => resolveConfig({ local: { provider: 'a', model: 'b' }, cloud: { provider: 'a', model: 'b' } }),
    /must be different models/,
  )
})

test('deterministic rules find secrets, PII, home directories and configured terms', () => {
  const text = [
    'key sk-abcdefghijklmnopqrstuv',
    'password = hunter22secret',
    'mail me at alice@example.com or 13812345678',
    'see /home/alice/work/app/src/index.ts',
    'project Bluebird is late',
  ].join('\n')
  const findings = detect(text, ['bluebird'])
  const byId = Object.fromEntries(findings.map(finding => [finding.id, finding.text]))
  assert.equal(byId['openai-key'], 'sk-abcdefghijklmnopqrstuv')
  assert.equal(byId['assigned-secret'], 'hunter22secret')
  assert.equal(byId.email, 'alice@example.com')
  assert.equal(byId['cn-phone'], '13812345678')
  assert.equal(byId['local-path'], '/home/alice')
  assert.equal(byId['configured-sensitive-term'], 'Bluebird')
  assert.deepEqual(detect('Explain how TCP slow start works.', []), [])
})

test('masking is stable per vault and secrets-only level leaves PII alone', () => {
  const vault = new MaskVault()
  const options = { level: 'full' as const, sensitiveTerms: [], entities: ['张三'] }
  const first = maskText(vault, '张三 (zhang@corp.cn) 改了 /home/zs/app', options)
  assert.equal(first, '⟦PRIVATE_1⟧ (⟦EMAIL_1⟧) 改了 ⟦HOME_1⟧/app')
  assert.equal(maskText(vault, '再问一次张三', { level: 'secrets', sensitiveTerms: [] }), '再问一次⟦PRIVATE_1⟧')
  assert.equal(maskText(vault, 'token sk-abcdefghijklmnopqrstuv and bob@x.io', { level: 'secrets', sensitiveTerms: [] }),
    'token ⟦SECRET_1⟧ and bob@x.io')
  assert.equal(vault.unmask('⟦PRIVATE_1⟧ 在 ⟦HOME_1⟧ 里 ⟦PRIVATE_9⟧'), '张三 在 /home/zs 里 ⟦PRIVATE_9⟧')
})

test('streaming unmask holds back a placeholder split across chunks', () => {
  const vault = new MaskVault()
  vault.placeholderFor('Alice', 'PRIVATE')
  const unmasker = new StreamUnmasker(vault)
  const parts = ['Hi ⟦PRI', 'VATE', '_1⟧!', ' 价格 ⟦ 不是占位符'].map(part => unmasker.push(part))
  assert.deepEqual(parts.slice(0, 3), ['Hi ', '', 'Alice!'])
  assert.equal(parts.join('') + unmasker.flush(), 'Hi Alice! 价格 ⟦ 不是占位符')
})

test('classifier output parsing keeps only entities literally present in the candidate', () => {
  const candidate = '帮我给王五写封邮件，说 Orion 项目延期'
  const parsed = parseClassifierOutput(
    '<think>hmm {"x":1}</think>```json\n{"classification":"sensitive","reason":"names a person","entities":["王五","Orion","李四"],"maskable":true}\n```',
    candidate,
  )
  assert.deepEqual(parsed, {
    classification: 'sensitive',
    reason: 'names a person',
    entities: ['王五', 'Orion'],
    maskable: true,
  })
  assert.equal(parseClassifierOutput('I think it is public', candidate).classification, 'unknown')
  assert.equal(parseClassifierOutput('{"classification":"maybe"}', candidate).classification, 'unknown')
})
