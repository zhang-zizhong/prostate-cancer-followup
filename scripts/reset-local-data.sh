#!/usr/bin/env bash
# =========================================================
# 重置本地测试数据（只影响本机，绝不触碰线上服务器）
# 用法：bash ./scripts/reset-local-data.sh [--keep]
#   无参数  重置后停止服务
#   --keep  重置后保持服务运行，浏览器可直接访问
#
# 流程：停止服务 → 删除本地数据库与上传文件 → 启动建库 → 导入40例演示数据
# =========================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[0;33m'; B=$'\033[0;36m'; N=$'\033[0m'
info() { printf "${B}==>${N} %s\n" "$1"; }
ok()   { printf "  ${G}✓${N} %s\n" "$1"; }
bad()  { printf "  ${R}✗${N} %s\n" "$1"; }
warn() { printf "  ${Y}!${N} %s\n" "$1"; }

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d ' \r')
PORT=${PORT:-3000}
BASE="http://127.0.0.1:$PORT"

# 演示数据文件（优先用字段最全的那份）
DEMO=""
for F in "演示数据-40例患者.json" "测试数据40例.json"; do
  [ -f "$F" ] && DEMO="$F" && break
done
if [ -z "$DEMO" ]; then
  bad "找不到演示数据文件（演示数据-40例患者.json / 测试数据40例.json）"
  exit 1
fi

echo "${B}==========================================${N}"
echo "${B} 重置本地测试数据${N}"
echo "${B}==========================================${N}"
echo "  项目目录：$ROOT"
echo "  本地端口：$PORT"
echo "  演示数据：$DEMO"
echo
echo "${Y}注意：本脚本只操作本机 data/ 目录，${N}"
echo "${Y}      与线上服务器完全无关，不会上传任何数据。${N}"
echo
printf "确认清空本地数据库并重新导入演示数据？[y/N] "
read -r CONFIRM
case "$CONFIRM" in
  y|Y|yes|YES) ;;
  *) echo "已取消"; exit 0 ;;
esac

# ---------- 1. 停止本地服务 ----------
echo
info "【1/5】停止本地服务"
PIDS=$(lsof -ti:"$PORT" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill 2>/dev/null || true
  sleep 1
  # 仍在运行则强制结束
  STILL=$(lsof -ti:"$PORT" 2>/dev/null || true)
  [ -n "$STILL" ] && echo "$STILL" | xargs kill -9 2>/dev/null || true
  ok "已停止占用 $PORT 端口的进程"
else
  ok "$PORT 端口空闲，无需停止"
fi

# ---------- 2. 清理数据 ----------
echo
info "【2/5】清理本地数据库与上传文件"
if [ -d data ]; then
  # 只删数据库文件，保留目录本身
  rm -f data/clinical.db data/clinical.db-shm data/clinical.db-wal data/clinical.db-journal 2>/dev/null
  ok "已删除本地数据库文件"
else
  mkdir -p data
  ok "data 目录不存在，已新建"
fi

# 清理上传文件，保留 .gitkeep
if [ -d uploads ]; then
  find uploads -type f ! -name '.gitkeep' -delete 2>/dev/null
  ok "已清空 uploads/ 上传文件"
else
  mkdir -p uploads && touch uploads/.gitkeep
  ok "已新建 uploads 目录"
fi

# ---------- 3. 启动服务建库 ----------
echo
info "【3/5】启动服务以初始化数据库"
# 检查 .env 是否配置了初始管理员
INIT_USER=$(grep -E '^INIT_ADMIN_USER=' .env 2>/dev/null | cut -d= -f2- | tr -d ' \r')
INIT_PASS=$(grep -E '^INIT_ADMIN_PASS=' .env 2>/dev/null | cut -d= -f2- | tr -d ' \r')
if [ -z "$INIT_USER" ] || [ -z "$INIT_PASS" ]; then
  bad ".env 中缺少 INIT_ADMIN_USER 或 INIT_ADMIN_PASS"
  echo "  数据库为空时首次启动必须提供初始管理员账号，否则 server.js 会拒绝启动"
  echo "  请在 .env 中补上这两行（用户名不得为 admin，密码≥12位）："
  echo "    INIT_ADMIN_USER=local_dev"
  echo "    INIT_ADMIN_PASS=你的强密码"
  exit 1
fi

LOG="/tmp/pcd-reset-$$.log"
nohup npm start > "$LOG" 2>&1 &
SRV_PID=$!

# 等待服务就绪（最多 25 秒）
READY=0
for i in $(seq 1 25); do
  if curl -sf -o /dev/null --max-time 2 "$BASE/" 2>/dev/null; then
    READY=1
    break
  fi
  # 进程已退出说明启动失败
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [ "$READY" != "1" ]; then
  bad "服务启动失败，日志如下："
  cat "$LOG" 2>/dev/null | tail -20 | sed 's/^/    /'
  rm -f "$LOG"
  kill "$SRV_PID" 2>/dev/null || true
  exit 1
fi
ok "服务已启动（等待 ${i} 秒）"
if grep -q "服务已启动" "$LOG" 2>/dev/null; then
  ok "启动日志确认：数据库已创建，初始管理员已写入"
fi

# ---------- 4. 导入演示数据 ----------
echo
info "【4/5】导入演示数据"
RESULT=$(python3 - "$BASE" "$INIT_USER" "$INIT_PASS" "$DEMO" <<'PYEOF'
import json, sys, urllib.request, urllib.error
BASE, USER, PASS, DEMO = sys.argv[1:5]

def req(path, payload=None, tok=None, raw=None):
    data = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
    r = urllib.request.Request(BASE + path, data=data,
                               headers={'Content-Type': 'application/json'})
    if tok: r.add_header('Authorization', 'Bearer ' + tok)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {'_http_error': e.code, '_body': e.read().decode(errors='replace')[:300]}
    except Exception as e:
        return {'_error': f'{type(e).__name__}: {e}'}

# 登录
login = req('/api/auth/login', {'username': USER, 'password': PASS})
tok = login.get('token')
if not tok:
    print('LOGIN_FAIL:' + json.dumps(login, ensure_ascii=False)[:200]); sys.exit(1)
print('LOGIN_OK')

# 读取备份文件（接口要求把备份内容包在 data 字段里）
try:
    backup = json.load(open(DEMO, encoding='utf-8'))
except Exception as e:
    print('READ_FAIL:' + str(e)); sys.exit(1)

imp = req('/api/backup/import', {'data': backup, 'mode': 'overwrite'}, tok)
if imp.get('ok'):
    print(f"IMPORT_OK:{imp.get('added')}")
else:
    print('IMPORT_FAIL:' + json.dumps(imp, ensure_ascii=False)[:200]); sys.exit(1)

# 校验
r = urllib.request.Request(BASE + '/api/patients', headers={'Authorization': 'Bearer ' + tok})
with urllib.request.urlopen(r, timeout=60) as resp:
    ps = json.loads(resp.read())
ps = ps.get('patients', ps) if isinstance(ps, dict) else ps
psa_total = sum(len(p.get('psa', [])) for p in ps)
print(f'VERIFY_OK:{len(ps)}:{psa_total}')
if ps:
    print('SAMPLE:' + '、'.join(p.get('name', '?') for p in ps[:3]))
PYEOF
)

echo "$RESULT" | sed 's/^/    /' | while read -r LINE; do
  case "$LINE" in
    *LOGIN_OK*)     echo "  ${G}✓${N} 管理员账号登录成功" ;;
    *IMPORT_OK*)    echo "  ${G}✓${N} 演示数据导入成功（$(echo "$LINE" | cut -d: -f2) 位患者）" ;;
    *VERIFY_OK*)    echo "  ${G}✓${N} 数据库校验通过：$(echo "$LINE" | cut -d: -f2) 位患者，$(echo "$LINE" | cut -d: -f3) 条 PSA 记录" ;;
    *SAMPLE*)       echo "  ${G}✓${N} 示例：$(echo "$LINE" | cut -d: -f2-)" ;;
    *FAIL*)         echo "  ${R}✗${N} $LINE" ;;
  esac
done

if echo "$RESULT" | grep -q "_FAIL"; then
  bad "导入过程出现失败，服务已停止，请查看上方日志"
  kill "$SRV_PID" 2>/dev/null || true
  lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  rm -f "$LOG"
  exit 1
fi

# ---------- 5. 收尾 ----------
echo
info "【5/5】收尾"
rm -f "$LOG"
if [ "$KEEP" = "1" ]; then
  ok "服务保持运行中（PID $SRV_PID）"
  echo
  echo "${G}==========================================${N}"
  echo "${G}  ✅ 数据重置完成，服务已就绪${N}"
  echo "${G}==========================================${N}"
  echo "  访问地址：$BASE"
  echo "  登录账号：$INIT_USER"
  echo "  停止服务：bash ./scripts/reset-local-data.sh 前先用「④ 停止本地服务」任务"
else
  # 优雅停止：SIGTERM 会让 server.js 正常关闭数据库（见 server.js 末尾的信号处理）
  kill "$SRV_PID" 2>/dev/null || true
  sleep 2
  lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  ok "服务已停止，数据库文件保留"
  echo
  echo "${G}==========================================${N}"
  echo "${G}  ✅ 数据重置完成${N}"
  echo "${G}==========================================${N}"
  echo "  数据库已重建：data/clinical.db"
  echo "  患者数据：40 例演示数据"
  echo "  管理员账号：$INIT_USER"
  echo
  echo "  启动网站：npm start  或  VS Code 任务「① 启动网站」"
  echo "  访问地址：$BASE"
fi
