# P1 mock LLM 网关（dev-only，零真实凭据；OpenAI-compatible /v1/chat/completions）。
# 依据：docs/design/deploy-contract.md §7.3、docs/design/fde-platform.md §11。
# 不进生产：P3 由真实 LLM 网关（LiteLLM 等）占据 127.0.0.1:4000 回环端口。
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./

ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.mjs"]
