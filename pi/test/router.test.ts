import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context, Message, Tool } from '@mariozechner/pi-ai'
import {
  allText,
  classifierReply,
  createHarness,
  fauxAssistantMessage,
  fauxToolCall,
  recording,
  run,
  textOf,
  user,
} from './helpers.ts'

const TOOLS = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }] as unknown as Tool[]
const SYSTEM = 'You are a coding agent working in /home/alice/secret-project.'

function context(messages: Message[]): Context {
  return { systemPrompt: SYSTEM, messages, tools: TOOLS }
}

test('public requests stream from the cloud with a fixed prompt and no tools', async t => {
  const h = createHarness()
  t.after(() => h.cleanup())
  h.local.setResponses([recording(h.seen.local, classifierReply({ classification: 'public', reason: 'general question', entities: [] }))])
  h.cloud.setResponses([recording(h.seen.cloud, fauxAssistantMessage('TCP slow start doubles the window.'))])

  const { message, streamed } = await run(h, context([user('Explain TCP slow start.')]))

  assert.equal(textOf(message), 'TCP slow start doubles the window.')
  assert.equal(streamed, 'TCP slow start doubles the window.')
  assert.equal(message.provider, 'test-cloud')
  assert.equal(h.seen.cloud.length, 1)
  assert.deepEqual(h.seen.cloud[0]!.tools, [])
  assert.doesNotMatch(h.seen.cloud[0]!.systemPrompt!, /secret-project/)
  assert.deepEqual(h.seen.cloud[0]!.messages.map(textOf), ['Explain TCP slow start.'])
  assert.deepEqual(h.decisions.map(d => [d.route, d.classification, d.method]), [['cloud', 'public', 'model']])
})

test('deterministic hits stay local without calling the classifier or the cloud', async t => {
  const h = createHarness()
  t.after(() => h.cleanup())
  h.local.setResponses([recording(h.seen.local, fauxAssistantMessage('Rotated.'))])

  const original = context([user('Rotate api_key=abcd1234efgh in config.ts')])
  const { message } = await run(h, original)

  assert.equal(textOf(message), 'Rotated.')
  assert.equal(h.cloud.state.callCount, 0)
  assert.equal(h.seen.local.length, 1)
  assert.equal(h.seen.local[0]!.systemPrompt, SYSTEM)
  assert.equal(h.seen.local[0]!.tools!.length, 1)
  assert.deepEqual(h.decisions.map(d => [d.route, d.method, d.reason]), [['local', 'deterministic', 'assigned-secret']])
})

test('sensitive, unknown, unparseable and failed classifications stay local', async t => {
  for (const reply of [
    classifierReply({ classification: 'sensitive', reason: 'internal', entities: [], maskable: false }),
    classifierReply({ classification: 'unknown', reason: 'unsure', entities: [] }),
    fauxAssistantMessage('probably fine?'),
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'ollama down' }),
  ]) {
    const h = createHarness({ sensitiveRoute: 'mask' })
    t.after(() => h.cleanup())
    h.local.setResponses([reply, fauxAssistantMessage('local answer')])
    const { message } = await run(h, context([user('What does our billing service do on retries?')]))
    assert.equal(textOf(message), 'local answer')
    assert.equal(h.cloud.state.callCount, 0)
    assert.equal(h.decisions[0]!.route, 'local')
  }
})

test('missing classifier model falls back to local instead of failing open', async t => {
  const h = createHarness({ classifier: { provider: 'nope', model: 'missing' } })
  t.after(() => h.cleanup())
  h.local.setResponses([fauxAssistantMessage('local answer')])
  await run(h, context([user('Explain TCP slow start.')]))
  assert.equal(h.cloud.state.callCount, 0)
  assert.match(h.decisions[0]!.classifier!.error!, /nope\/missing is not configured/)
})

test('sensitiveRoute=mask sends placeholders to the cloud and restores them in the reply', async t => {
  const h = createHarness({ sensitiveRoute: 'mask' })
  t.after(() => h.cleanup())
  h.local.setResponses([classifierReply({
    classification: 'sensitive',
    reason: 'names a person',
    entities: ['王五', 'Orion'],
    maskable: true,
  })])
  h.cloud.setResponses([recording(h.seen.cloud, context => {
    const prompt = textOf(context.messages.at(-1)!)
    const person = /⟦PRIVATE_\d+⟧/.exec(prompt)![0]
    const email = /⟦EMAIL_\d+⟧/.exec(prompt)![0]
    return fauxAssistantMessage(`${person}您好，关于 ⟦PRIVATE_2⟧ 项目延期，请回复 ${email}。`)
  })])

  const { message, streamed } = await run(h, context([user('给王五 (wangwu@corp.cn) 写封信，说 Orion 项目延期')]))

  const sent = allText(h.seen.cloud[0]!)
  for (const secret of ['王五', 'Orion', 'wangwu@corp.cn']) assert.doesNotMatch(sent, new RegExp(secret))
  assert.equal(textOf(message), '王五您好，关于 Orion 项目延期，请回复 wangwu@corp.cn。')
  assert.equal(streamed, textOf(message))
  assert.deepEqual(h.decisions.map(d => [d.route, d.classification]), [['masked-cloud', 'sensitive']])
})

test('sensitiveRoute=mask can send a request whose only sensitive part is a credential', async t => {
  const h = createHarness({ sensitiveRoute: 'mask' })
  t.after(() => h.cleanup())
  h.local.setResponses([classifierReply({ classification: 'public', reason: 'generic', entities: [] })])
  h.cloud.setResponses([recording(h.seen.cloud, fauxAssistantMessage('Rotate ⟦SECRET_1⟧ in your vault.'))])

  const { message } = await run(h, context([user('How do I rotate password=hunter2hunter2 safely?')]))

  assert.doesNotMatch(allText(h.seen.cloud[0]!), /hunter2hunter2/)
  assert.equal(textOf(message), 'Rotate hunter2hunter2 in your vault.')
  assert.deepEqual(h.decisions.map(d => [d.route, d.classification]), [['masked-cloud', 'sensitive']])
})

test('a one-shot /privacy mask overrides the default local route for one turn only', async t => {
  const h = createHarness()
  t.after(() => h.cleanup())
  h.router.setMode('mask')
  assert.equal(h.router.pending, 'mask')
  h.local.setResponses([
    classifierReply({ classification: 'sensitive', reason: 'person', entities: ['Alice'], maskable: false }),
    fauxAssistantMessage('local again'),
  ])
  h.cloud.setResponses([recording(h.seen.cloud, fauxAssistantMessage('Dear ⟦PRIVATE_1⟧'))])

  const first = await run(h, context([user('Draft a note to Alice', 1)]))
  assert.equal(textOf(first.message), 'Dear Alice')
  assert.doesNotMatch(allText(h.seen.cloud[0]!), /Alice/)
  assert.equal(h.router.pending, undefined)

  const second = await run(h, context([
    user('Draft a note to Alice', 1),
    first.message,
    user('Add password=hunter2hunter2', 2),
  ]))
  assert.equal(textOf(second.message), 'local again')
  assert.deepEqual(h.decisions.map(d => [d.route, d.mode]), [['masked-cloud', 'mask'], ['local', 'auto']])
})

test('forced cloud skips classification but still masks credentials', async t => {
  const h = createHarness()
  t.after(() => h.cleanup())
  h.router.setMode('cloud')
  h.cloud.setResponses([recording(h.seen.cloud, fauxAssistantMessage('ok'))])

  await run(h, context([user('Why does bob@corp.cn get 401 with token sk-abcdefghijklmnopqrstuv?')]))

  assert.equal(h.local.state.callCount, 0)
  const sent = allText(h.seen.cloud[0]!)
  assert.match(sent, /bob@corp\.cn/)
  assert.doesNotMatch(sent, /sk-abcdefghijklmnopqrstuv/)
  assert.deepEqual(h.decisions.map(d => [d.route, d.method]), [['cloud', 'manual']])
})

test('cloud tool calls are rejected while cloudTools is none', async t => {
  const h = createHarness()
  t.after(() => h.cleanup())
  h.local.setResponses([classifierReply({ classification: 'public', reason: 'general', entities: [] })])
  h.cloud.setResponses([fauxAssistantMessage([fauxToolCall('read', { path: '/etc/passwd' })], { stopReason: 'toolUse' })])

  const { message } = await run(h, context([user('Explain TCP slow start.')]))

  assert.equal(message.stopReason, 'error')
  assert.match(message.errorMessage!, /cannot call local tools/)
})

test('local turns are withheld from later cloud context while public turns are kept', async t => {
  const h = createHarness()
  t.after(() => h.cleanup())
  h.local.setResponses([
    classifierReply({ classification: 'public', reason: 'general', entities: [] }),
    classifierReply({ classification: 'sensitive', reason: 'internal', entities: [] }),
    fauxAssistantMessage('Internal answer about Q3 revenue'),
    classifierReply({ classification: 'public', reason: 'general', entities: [] }),
  ])
  h.cloud.setResponses([
    fauxAssistantMessage('Public answer one'),
    recording(h.seen.cloud, fauxAssistantMessage('Public answer two')),
  ])

  const messages: Message[] = [user('What is a B-tree?', 1)]
  messages.push((await run(h, context(messages))).message)
  messages.push(user('Summarise our Q3 revenue numbers', 2))
  messages.push((await run(h, context(messages))).message)
  messages.push(user('And how does a B+ tree differ?', 3))
  await run(h, context(messages))

  const sent = h.seen.cloud[0]!.messages.map(textOf)
  assert.deepEqual(sent, ['What is a B-tree?', 'Public answer one', 'And how does a B+ tree differ?'])
  assert.deepEqual(h.decisions.map(d => d.route), ['cloud', 'local', 'cloud'])
})

test('cloudTools=masked lets the cloud use tools with masked context and unmasked arguments', async t => {
  const h = createHarness({ cloudTools: 'masked', sensitiveRoute: 'mask' })
  t.after(() => h.cleanup())
  h.local.setResponses([classifierReply({
    classification: 'sensitive',
    reason: 'local path',
    entities: [],
    maskable: true,
  })])
  h.cloud.setResponses([
    recording(h.seen.cloud, context => {
      const path = /⟦HOME_\d+⟧\/app\/main\.ts/.exec(textOf(context.messages.at(-1)!))![0]
      return fauxAssistantMessage([fauxToolCall('read', { path }, { id: 'call-1' })], { stopReason: 'toolUse' })
    }),
    recording(h.seen.cloud, fauxAssistantMessage('It prints the token for ⟦HOME_1⟧.')),
  ])

  const messages: Message[] = [user('Explain /home/alice/app/main.ts', 1)]
  const step1 = await run(h, context(messages))
  const call = step1.message.content.find(block => block.type === 'toolCall')
  assert.deepEqual(call?.type === 'toolCall' ? call.arguments : undefined, { path: '/home/alice/app/main.ts' })

  messages.push(step1.message, {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'read',
    content: [{ type: 'text', text: 'console.log(process.env.TOKEN) // owner alice@corp.cn' }],
    isError: false,
    timestamp: 2,
  })
  const step2 = await run(h, context(messages))

  assert.equal(textOf(step2.message), 'It prints the token for /home/alice.')
  assert.equal(h.local.state.callCount, 1, 'the tool continuation reuses the first decision')
  const continuation = h.seen.cloud[1]!
  assert.equal(continuation.tools!.length, 1)
  assert.doesNotMatch(allText(continuation), /\/home\/alice|alice@corp\.cn/)
  assert.match(allText(continuation), /secret-project/, 'project system prompt is sent, masked')
})

test('reset restores only public cloud approvals', async t => {
  const h = createHarness()
  t.after(() => h.cleanup())
  h.local.setResponses([classifierReply({ classification: 'public', reason: 'general', entities: [] })])
  h.cloud.setResponses([fauxAssistantMessage('A1'), recording(h.seen.cloud, fauxAssistantMessage('A2'))])

  const messages: Message[] = [user('Q1 public', 1)]
  messages.push((await run(h, context(messages))).message)
  const [first] = h.decisions
  h.router.reset([
    { turnKey: first!.turnKey, route: 'cloud' },
    { turnKey: 'masked-turn', route: 'masked-cloud' },
  ])
  h.router.setMode('cloud')
  messages.push(user('Q2', 2))
  await run(h, context(messages))
  assert.deepEqual(h.seen.cloud[0]!.messages.map(textOf), ['Q1 public', 'A1', 'Q2'])
})

test('compaction summaries of the whole conversation always run locally', async t => {
  const h = createHarness()
  t.after(() => h.cleanup())
  h.local.setResponses([recording(h.seen.local, fauxAssistantMessage('## Goal\n...'))])

  const { message } = await run(h, {
    systemPrompt: 'You are a context summarization assistant. Your task is to read a conversation...',
    messages: [user('<conversation>secret local work</conversation>')],
  })

  assert.equal(textOf(message), '## Goal\n...')
  assert.equal(h.local.state.callCount, 1, 'no classifier call, only the summary')
  assert.equal(h.cloud.state.callCount, 0)
  assert.deepEqual(h.decisions, [])
})
