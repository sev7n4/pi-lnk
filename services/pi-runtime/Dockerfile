FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY services/pi-runtime/package.json services/pi-runtime/
RUN pnpm install --filter @pi-lnk/pi-runtime --frozen-lockfile

FROM deps AS build
COPY vendor ./vendor
COPY services/pi-runtime/ services/pi-runtime/
COPY skills ./skills
RUN pnpm --filter @pi-lnk/pi-runtime build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8100
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/pi-runtime/node_modules ./services/pi-runtime/node_modules
COPY --from=build /app/services/pi-runtime/dist ./services/pi-runtime/dist
COPY --from=build /app/services/pi-runtime/package.json ./services/pi-runtime/
COPY --from=build /app/skills ./skills
EXPOSE 8100
CMD ["node", "services/pi-runtime/dist/index.js"]
