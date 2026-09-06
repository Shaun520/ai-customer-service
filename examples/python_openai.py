# Python 接入示例：官方 openai SDK 直连网关
# 运行：pip install openai && python examples/python_openai.py
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8787/v1",      # 指向本地 AI 网关
    api_key="aics_xxxx_yyyy",                  # 网关签发的 API Key
)

# 1. 普通对话（自动走 RAG + 合规护栏）
resp = client.chat.completions.create(
    model="gpt-4o",  # 网关忽略 model 字段，实际由网关路由决定
    messages=[{"role": "user", "content": "诊所什么时候可以打流感疫苗"}],
)
print("回复:", resp.choices[0].message.content)

# 网关扩展字段（额外属性通过 model_extra 访问）
extra = resp.model_extra or {}
print("引用:", extra.get("aics", {}).get("citations"))
print("trace_id:", extra.get("aics", {}).get("trace_id"))

# 2. 流式对话
stream = client.chat.completions.create(
    model="gpt-4o",
    stream=True,
    messages=[{"role": "user", "content": "验血前要注意什么"}],
)
for chunk in stream:
    delta = chunk.choices[0].delta.content if chunk.choices else None
    if delta:
        print(delta, end="", flush=True)
print()
