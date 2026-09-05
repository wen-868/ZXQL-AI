# ============================================================================
# 智享AI底座 — 容器镜像（多阶段构建）
#
# 阶段 1（build）：node:22-alpine + corepack(pnpm) → 安装全量依赖（含 dev）→ 编译 dist
# 阶段 2（runtime）：仅拷贝依赖清单 + dist 产物 + 生产依赖，精简镜像体积
#
# 依赖网络注意事项：
# - pnpm install 使用 --frozen-lockfile 锁定版本，依赖与本地开发完全一致
# - node:22-alpine 自带 corepack，无需单独安装 pnpm
#
# 负责人: 阿坚 | 创建日期: 2026-08-02
# ============================================================================

# ── 阶段 1：构建 ──────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# 激活 pnpm（node:22-alpine 自带 corepack）
RUN corepack enable

# 先拷贝依赖清单，利用 Docker 层缓存（源码变更时不重复 install）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 安装全量依赖（含 devDependencies，nest build 编译所需）
RUN pnpm install --frozen-lockfile

# 拷贝源码并编译
COPY . .
RUN pnpm run build

# ── 阶段 2：运行（精简）──────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

RUN corepack enable
ENV NODE_ENV=production

# 拷贝运行时依赖清单 + 编译产物
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-lock.yaml ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/dist ./dist

# 仅安装生产依赖（锁定版本）
RUN pnpm install --frozen-lockfile --prod

# 以非 root 运行（2026-09-05 审查：runtime 容器此前以 root 跑 node）
USER node

EXPOSE 3016

# 与 package.json start:prod 一致（node dist/main）
CMD ["node", "dist/main.js"]
