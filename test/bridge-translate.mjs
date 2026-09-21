/**
 * 协议翻译的快速回归测试（不启动 codex，秒级完成）。
 *
 * 用的输入是**真实抓取**的 codex-cli 0.154.0 请求体（test/fixtures/codex-responses-request.json），
 * 所以一旦 codex 改了协议形态，这个测试会先报出来。
 *
 * 运行：node test/bridge-translate.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const bundlePath = path.join(root, '.tmp', 'translate.bundle.mjs')
fs.mkdirSync(path.dirname(bundlePath), { recursive: true })
await build({
  entryPoints: [path.join(root, 'src/core/bridge/translate.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: bundlePath,
  logLevel: 'warning'
})
const { translateRequest, buildUpstreamBody } = await import(pathToFileURL(bundlePath).href)

const streamBundle = path.join(root, '.tmp', 'stream.bundle.mjs')
await build({
  entryPoints: [path.join(root, 'src/core/bridge/stream.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: streamBundle,
  logLevel: 'warning'
})
const { translateNonStreaming, ChatToResponsesTranslator } = await import(pathToFileURL(streamBundle).href)

const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'codex-responses-request.json'), 'utf8'))

/* ---------------- 工具声明 ---------------- */
const translation = translateRequest(fixture)
const tools = translation.tools

record('工具数量与真实请求一致（20 个扁平函数）', tools.length === 20, `实际 ${tools.length}`)
record(
  '所有函数名都符合 Chat Completions 命名规则',
  tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.function.name)),
  tools.find((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t.function.name))?.function.name ?? '全部合法'
)
record('web_search 被丢弃（DeepSeek 无对应能力）', translation.map.dropped.includes('web_search'), JSON.stringify(translation.map.dropped))
record(
  'namespace 工具被扁平化成 ns__tool',
  tools.some((t) => t.function.name === 'multi_agent_v1__spawn_agent'),
  tools
    .map((t) => t.function.name)
    .filter((n) => n.includes('__'))
    .slice(0, 4)
    .join(', ')
)
const spawn = translation.map.byChatName.get('multi_agent_v1__spawn_agent')
record('回程映射能还原 namespace 与裸名', spawn?.name === 'spawn_agent' && spawn?.namespace === 'multi_agent_v1', JSON.stringify(spawn))

/* ---------------- 消息组装 ---------------- */
const messages = translation.messages
record('首条是 system 消息', messages[0]?.role === 'system')
record('instructions 进入了 system', String(messages[0]?.content).includes('coding agent running in the Codex CLI'))
record('developer 消息也合并进了 system', String(messages[0]?.content).includes('permissions instructions'))
record(
  '相邻 user 消息被合并（真实请求里是 2 条）',
  messages.filter((m) => m.role === 'user').length === 1,
  `user 消息数=${messages.filter((m) => m.role === 'user').length}`
)
record('用户消息里保留了 environment_context', String(messages.find((m) => m.role === 'user')?.content).includes('<environment_context>'))

/* ---------------- 多轮：工具调用往返 ---------------- */
const secondTurn = {
  ...fixture,
  input: [
    ...fixture.input,
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'exec_command',
      arguments: '{"cmd":"echo hi"}'
    },
    {
      type: 'function_call_output',
      id: 'fco_1',
      call_id: 'call_1',
      output: 'Chunk ID: 1\nProcess exited with code 0\nFinal output:\nhi\n'
    }
  ]
}
const second = translateRequest(secondTurn)
const assistantCall = second.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
const toolResult = second.messages.find((m) => m.role === 'tool')
record('function_call 被翻成 assistant.tool_calls', Boolean(assistantCall), assistantCall ? assistantCall.tool_calls[0].function.name : '缺失')
record('tool_call_id 与 call_id 对齐', assistantCall?.tool_calls?.[0]?.id === 'call_1')
record('function_call_output 被翻成 role=tool', Boolean(toolResult && toolResult.tool_call_id === 'call_1'))
record('工具输出内容被保留', String(toolResult?.content).includes('Process exited with code 0'))

// 上游请求体组装
const upstream = buildUpstreamBody(second, { model: 'deepseek-chat', temperature: 0.2, maxOutputTokens: 0, stream: true, toolChoice: 'auto' })
record('上游请求体带上了 tools 与 tool_choice', upstream.tools?.length === 20 && upstream.tool_choice === 'auto')
record('上游请求体注入了 temperature（codex 本身没有这个配置项）', upstream.temperature === 0.2)
record('流式请求开启了 include_usage', JSON.stringify(upstream.stream_options) === '{"include_usage":true}')

/* ---------------- 回程：命名空间还原 ---------------- */
const chatResponse = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: '好，我来派个子 agent。',
        tool_calls: [
          {
            id: 'call_x',
            type: 'function',
            function: { name: 'multi_agent_v1__spawn_agent', arguments: '{"message":"do it"}' }
          }
        ]
      }
    }
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
}
const responsesBody = translateNonStreaming(chatResponse, translation.map, 'deepseek-chat')
const callItem = responsesBody.output.find((i) => i.type === 'function_call')
record('回程 function_call 还原成裸名 + namespace', callItem?.name === 'spawn_agent' && callItem?.namespace === 'multi_agent_v1', JSON.stringify({ name: callItem?.name, namespace: callItem?.namespace }))
record('回程 message 条目使用 output_text', responsesBody.output.some((i) => i.type === 'message' && i.content?.[0]?.type === 'output_text'))
record('usage 映射为 Responses 形状', responsesBody.usage?.input_tokens === 10 && responsesBody.usage?.output_tokens === 5)

/* ---------------- 流式：事件序列 ---------------- */
const emitted = []
const translator = new ChatToResponsesTranslator((type, payload) => emitted.push({ type, payload }), translation.map, 'deepseek-chat')
translator.begin()
translator.handlePayload(JSON.stringify({ choices: [{ delta: { reasoning_content: '先想一下' } }] }))
translator.handlePayload(JSON.stringify({ choices: [{ delta: { content: '你好' } }] }))
translator.handlePayload(
  JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s1', function: { name: 'exec_command', arguments: '{"cmd":' } }] } }]
  })
)
translator.handlePayload(
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: 'tool_calls' }] })
)
translator.handlePayload(JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }))
const streamResult = translator.finish()

const types = emitted.map((e) => e.type)
record('流式首个事件是 response.created', types[0] === 'response.created', types[0])
record('reasoning 走 reasoning_summary_text.delta', types.includes('response.reasoning_summary_text.delta'))
record('正文走 output_text.delta', types.includes('response.output_text.delta'))
record('工具参数走 function_call_arguments.delta', types.includes('response.function_call_arguments.delta'))
record('收流最后是 response.completed', types[types.length - 1] === 'response.completed', types[types.length - 1])
record(
  '分片到达的工具名/参数被正确拼接',
  streamResult.output.some((i) => i.type === 'function_call' && i.name === 'exec_command' && i.arguments === '{"cmd":"ls"}'),
  JSON.stringify(streamResult.output.find((i) => i.type === 'function_call')?.arguments)
)
const completed = emitted.find((e) => e.type === 'response.completed')
const outputOrder = completed.payload.response.output.map((i) => i.type).join(',')
record('output 顺序为 reasoning → message → function_call', outputOrder === 'reasoning,message,function_call', outputOrder)
record('sequence_number 单调递增', emitted.every((e, i) => e.payload.sequence_number === i + 1))

/* ---------------- 错误路径 ---------------- */
const errEmitted = []
const errTranslator = new ChatToResponsesTranslator((type, payload) => errEmitted.push({ type, payload }), translation.map, 'deepseek-chat')
errTranslator.begin()
errTranslator.fail('上游炸了')
record('错误路径下发 response.failed', errEmitted.some((e) => e.type === 'response.failed'))

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
process.exit(failed.length === 0 ? 0 : 1)
