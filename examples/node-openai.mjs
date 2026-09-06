/**
 * Node.js 接入示例：直接使用官方 OpenAI SDK，仅需替换 baseURL 与 apiKey。
 * 运行：node examples/node-openai.mjs
 */
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8787/v1', // 指向本地 AI 网关
  apiKey: process.env.AICS_API_KEY ?? 'aics_xxxx_yyyy', // 网关签发的 API Key
});

// 1. 普通对话（自动走 RAG + 合规护栏）
const res = await client.chat.completions.create({
  messages: [{ role: 'user', content: '诊所什么时候可以打流感疫苗' }],
});
console.log('回复:', res.choices[0].message.content);
// 网关扩展字段（OpenAI SDK 透传未知字段）:
console.log('引用:', (res as any).aics?.citations);
console.log('trace_id:', (res as any).aics?.trace_id);

// 2. 流式对话
const stream = await client.chat.completions.create({
  stream: true,
  messages: [{ role: 'user', content: '验血前要注意什么' }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
