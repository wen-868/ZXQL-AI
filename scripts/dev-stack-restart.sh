#!/bin/bash
# dev-stack-restart — 本地全栈一键重启（MariaDB → 管理系统后端 → AI 底座）
# 用法：bash scripts/dev-stack-restart.sh
# 依赖：本仓 .env 与 ../ZXQL-MS/wen-ssystem/backend/.env（见 local-mariadb-setup 记忆）
set -e

MARIA_DIR="D:/Users/ZXQL/tools/mariadb"
MARIA_BIN="$MARIA_DIR/mariadb-11.4.5-winx64/bin"
BACKEND_DIR="D:/Users/ZXQL/ZXQL-MS/wen-ssystem/backend"

echo "[1/4] MariaDB..."
if ! netstat -ano | grep -q ":3306 .*LISTENING"; then
  (cd "$MARIA_DIR" && ./mariadb-11.4.5-winx64/bin/mysqld.exe --defaults-file="D:/Users/ZXQL/tools/mariadb/data/my.ini" --skip-ssl --console > /tmp/maria.log 2>&1 &)
  sleep 8
fi
netstat -ano | grep ":3306 .*LISTENING" | head -1 || { echo "MariaDB 启动失败"; exit 1; }

echo "[2/4] 管理系统后端 (8080)..."
if ! netstat -ano | grep -q ":8080 .*LISTENING"; then
  (cd "$BACKEND_DIR" && NODE_ENV=production node dist/server.js > /tmp/backend.log 2>&1 &)
  sleep 10
fi
curl -s -m 5 -o /dev/null -w "backend %{http_code}\n" http://127.0.0.1:8080/health

echo "[3/4] AI 底座 (3016)..."
if ! netstat -ano | grep -q ":3016 .*LISTENING"; then
  (cd "D:/Users/ZXQL/ZXQL-AI" && node dist/main.js > /tmp/aibase.log 2>&1 &)
  sleep 14
fi
curl -s -m 5 -o /dev/null -w "aibase %{http_code}\n" http://127.0.0.1:3016/api/health

echo "[4/4] 全栈就绪"
