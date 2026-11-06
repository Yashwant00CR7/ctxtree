// The core plugin's guard rails, run by `claude plugin test plugins/ctxtree`:
// the engine's own host loads the plugin; these hooks stand in for the engine
// beneath it (the session's transcript on disk, usage, the processes it runs).
import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const SID = '11111111-2222-4333-8444-555555555555'
const CFG = '/home/t/.claude'
const FILE = `${CFG}/projects/-p/${SID}.jsonl`
const BIG = 'BIGRESULT '.repeat(800)

// Two tasks: the first reads a big file; the second asks for a summary.
function transcript() {
  const base = { sessionId: SID, cwd: '/p', version: '2.1.312', userType: 'external', isSidechain: false }
  const usage = { input_tokens: 9000, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  let parent: string | null = null, n = 0
  const recs: any[] = []
  const push = (r: any) => { const rec = { ...base, parentUuid: parent, timestamp: new Date(Date.UTC(2026, 10, 1, 10, 0, n++)).toISOString(), ...r }; recs.push(rec); parent = rec.uuid }
  push({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'please read the big file for me now' } })
  push({ type: 'assistant', uuid: 'a1', message: { id: 'msg_1', role: 'assistant', model: 'c', content: [{ type: 'tool_use', id: 'toolu_big', name: 'Read', input: { file_path: '/p/big.txt' } }], usage } })
  push({ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: BIG }] }, toolUseResult: 'BIG' })
  push({ type: 'assistant', uuid: 'a2', message: { id: 'msg_2', role: 'assistant', model: 'c', content: [{ type: 'text', text: 'It is big.' }], usage } })
  push({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'now summarise what you found there' } })
  push({ type: 'assistant', uuid: 'a3', message: { id: 'msg_3', role: 'assistant', model: 'c', content: [{ type: 'text', text: 'A big file of one repeated word.' }], usage } })
  return recs.map(r => JSON.stringify(r)).join('\n') + '\n'
}

// The world beneath: files in memory, the processes ctxtree runs recorded.
function engine(on: On, { vtower = true } = {}) {
  const files = new Map<string, string>([[FILE, transcript()]])
  const runs: string[][] = []
  on('session.start', ($, e) => ({ cwd: e.cwd } as any))
  mock.env(on, { HOME: '/home/t' })
  mock.store(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 50000, window: 200000 }, rateLimits: [] } as any }))
  on('session.cwd', () => ({ value: '/p' }))
  on('session.id', () => ({ value: SID }))
  on('session.turns', () => ({ value: 3 }))
  on('fs.exists', ($, e: any) => ({ value: files.has(e.path) || (vtower && e.path === '/Applications/vTower.app') }))
  on('fs.stat', ($, e: any) => {
    if (!files.has(e.path)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: files.get(e.path)!.length, mtimeMs: 0, isLink: false } as any }
  })
  on('fs.read', ($, e: any) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e: any) => { files.set(e.path, e.text); return { value: undefined } })
  on('process.spawn', async function* ($: any, e: any) {
    if (e.argv[0] === 'cat' && files.has(e.argv[1])) yield { stream: 'stdout' as const, text: files.get(e.argv[1])! }
    return { value: { code: 0, signal: null } }
  } as any)
  on('process.run', ($, e: any) => {
    const a = e.argv as string[]
    runs.push(a)
    if (a[0] === 'mv') { files.set(a[3], files.get(a[2])!); files.delete(a[2]) }
    if (a[0] === 'rm') for (const f of a.slice(2)) files.delete(f)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as any }
  })
  on('tool.register', ($, e) => ({ value: { tool: e } as any }))
  on('ui.toast', () => ({ value: undefined }))
  return { files, runs }
}

// The test's own $ carries Claude Code's nouns only; a second plugin calls
// $.ctxtree, as ctxtree-ui does, and answers a pretend tool with the value.
const KIT = [{
  name: 'kit',
  register(on: On) {
    on('tool.call', { tool: 'kit' } as any, async ($: any, e: any) => {
      if (e.op === 'plan') return { result: (await $.state.get({ plugin: 'ctxtree', key: 'plan' })).value }
      if (e.op === 'status') return { result: (await $.state.get({ plugin: 'ctxtree', key: 'status' })).value }
      if (e.op === 'rows') return { result: await $.ctxtree.rows(e.args) }
      if (e.op === 'mark') return { result: await $.ctxtree.mark(e.args) }
      if (e.op === 'timeline') return { result: await $.ctxtree.timeline(e.args) }
      if (e.op === 'review') return { result: await $.ctxtree.review(e.args) }
      if (e.op === 'approve') return { result: await $.ctxtree.approve(e.args) }
      return { deny: `unknown op ${e.op}` }
    })
  },
}]
const call = async ($: any, op: string, args: unknown = { why: 'test' }) => ((await $.tool.call({ tool: 'kit', op, args })) as any).result
const rowsOf = ($: any, view: string, expanded: string[] = []) => call($, 'rows', { view, expanded, sort: 'tok', filter: '', sel: '', top: 0, count: 50, move: 0 })

async function markBigResult($: any) {
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const r = await rowsOf($, 'type', ['g:results', 'g:r:Read'])
  const row = r.rows.find((x: any) => x.name.includes('big.txt'))
  expect(row).toBeDefined()
  await call($, 'mark', { ids: [row.id], op: 'toggle' })
  return row
}

test('a marked tool output is a whole step; the review builds the fork and writes nothing', { plugins: KIT }, async ($, on) => {
  const w = engine(on)
  await markBigResult($)
  const plan = await call($, 'plan')
  expect(plan.entries.map((e: any) => e.key)).toEqual(['step:msg_1'])
  const rv = await call($, 'review')
  expect(rv.verified).toBe(true)
  expect(rv.save).toBeGreaterThan(1000)
  expect([...w.files.keys()]).toEqual([FILE])
})

test('Apply writes the fork without it, records it, opens it in vTower, and leaves the session alone', { plugins: KIT }, async ($, on) => {
  const w = engine(on)
  await markBigResult($)
  const r = await call($, 'approve')
  expect(r.ok).toBe(true)
  const fork = `${CFG}/projects/-p/${r.fork.forkSid}.jsonl`
  expect(w.files.has(fork)).toBe(true)
  expect(w.files.get(fork)).not.toContain('BIGRESULT')
  expect(w.files.get(fork)).toContain('please read the big file')
  expect(w.files.get(FILE)).toContain('BIGRESULT')
  expect([...w.files.keys()].some(k => k.includes('ctxtree-tmp'))).toBe(false)
  const lineage = JSON.parse(w.files.get(`${CFG}/ctxtree/lineage.jsonl`)!.trim())
  expect(lineage.forkSid).toBe(r.fork.forkSid)
  expect(lineage.parentSid).toBe(SID)
  expect(w.runs).toContainEqual(['open', `vtower://resume/${r.fork.forkSid}?cwd=%2Fp`])
  expect(r.fork.opened).toBe(true)
  expect((await call($, 'plan')).entries.length).toBe(0)
  expect((await call($, 'status')).lastApply.forkSid).toBe(r.fork.forkSid)
})

test('without vTower, Apply hands back the resume command', { plugins: KIT }, async ($, on) => {
  const w = engine(on, { vtower: false })
  await markBigResult($)
  const r = await call($, 'approve')
  expect(r.ok).toBe(true)
  expect(r.fork.opened).toBe(false)
  expect(r.fork.resumeCmd).toBe(`cd "/p" && claude --resume ${r.fork.forkSid}`)
  expect(w.runs.some(a => a[0] === 'open')).toBe(false)
})

test('your message takes its whole task, and the fork has no trace of it', { plugins: KIT }, async ($, on) => {
  const w = engine(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const r = await rowsOf($, 'type', ['g:conv', 'g:prompts'])
  const prompt = r.rows.find((x: any) => x.name.includes('please read the big file'))
  await call($, 'mark', { ids: [prompt.id], op: 'toggle' })
  const keys = (await call($, 'plan')).entries.map((e: any) => e.key).sort()
  expect(keys).toEqual(['step:msg_1', 'task:g:task:b_u1_0'])
  const rv = await call($, 'review')
  expect(rv.tasks).toBe(1)
  const done = await call($, 'approve')
  const fork = w.files.get(`${CFG}/projects/-p/${done.fork.forkSid}.jsonl`)!
  expect(fork).not.toContain('please read the big file')
  expect(fork).toContain('now summarise what you found there')
  // keeping a part of the task keeps the task
  await call($, 'mark', { ids: [prompt.id], op: 'toggle' })
  const rt = await rowsOf($, 'type', ['g:results', 'g:r:Read'])
  await call($, 'mark', { ids: [rt.rows.find((x: any) => x.name.includes('big.txt')).id], op: 'unmark' })
  expect((await call($, 'plan')).entries.length).toBe(0)
})

test('Claude stages through its tool; nothing is written', { plugins: KIT }, async ($, on) => {
  const w = engine(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const map: any = await $.tool.call({ tool: 'mcp__ctxtree__map', view: 'type' } as any)
  expect(map.result).toContain('Tool results')
  const r = await rowsOf($, 'type', ['g:results', 'g:r:Read'])
  const id = r.rows.find((x: any) => x.name.includes('big.txt'))!.id
  const staged: any = await $.tool.call({ tool: 'mcp__ctxtree__stage', items: [{ id }, { id: 'nope' }] } as any)
  expect(staged.result).toMatch(/Staged 1 deletion/)
  expect(staged.result).toMatch(/nope: no such item/)
  expect(staged.result).toMatch(/Nothing is deleted yet/)
  expect((await call($, 'plan')).entries[0].by).toBe('claude')
  expect([...w.files.keys()]).toEqual([FILE])
})

test('the timeline: a task in order, an open call carries 20,000 characters, all of it on request', { plugins: KIT }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const r = await rowsOf($, 'task')
  const task = r.rows.find((x: any) => x.id === 'g:task:b_u1_0')
  expect(task).toBeDefined()
  const closed = await call($, 'timeline', { id: task.id, open: [], all: [] })
  expect(closed.entries.map((e: any) => e.kind)).toEqual(['prompt', 'tool', 'reply'])
  expect(closed.entries[0].text).toBe('please read the big file for me now')
  const tool = closed.entries[1]
  expect(tool.parts.every((p: any) => p.text === undefined)).toBe(true)
  const open = await call($, 'timeline', { id: task.id, open: [tool.id], all: [] })
  const got = open.entries[1].parts.find((p: any) => p.role === 'got')
  expect(got.text).toBe(BIG)
  expect(got.next).toBe(0)
  await call($, 'mark', { ids: [tool.id], op: 'toggle' })
  const marked = await call($, 'timeline', { id: task.id, open: [], all: [] })
  expect(marked.entries[1].mark).toBe('all')
})
