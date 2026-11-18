# syntax=docker/dockerfile:1
# O Bun executa TypeScript direto: não há etapa de build, só dependências de produção.
FROM oven/bun:1.4.4-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
# tsconfig.json é lido pelo Bun em runtime (decorators e metadata do Nest)
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
