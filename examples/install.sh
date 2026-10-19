#!/usr/bin/env bash
set -euo pipefail

# One-shot local installer for opencode-cline-pass.
#
#   ./install.sh
#   CLINE_PASS_API_KEY=sk_... ./install.sh
#   ./install.sh --no-key --no-build
#
# It builds the checkout, links it into opencode's v2 plugin directory,
# initializes the config/credential files when absent, and verifies the entry.
# Re-running is safe: existing config, pins and credentials are preserved.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$CONFIG_HOME/plugins"
TARGET="$PLUGIN_DIR/cline-pass"
CONFIG_FILE="$CONFIG_HOME/cline-pass.json"
CREDENTIALS_FILE="$CONFIG_HOME/cline-pass.credentials.json"

KEY="${CLINE_PASS_API_KEY:-}"
FORCE=0
NO_BUILD=0
NO_KEY=0
ASSUME_YES=0

usage() {
  cat <<'USAGE'
用法: ./install.sh [选项]

选项:
  --key <sk_...>    写入 Cline Pass API Key（会留在 shell 历史里；交互输入更安全）
  --no-key          不提示、不写入密钥（凭据已存在时仍可正常使用）
  --no-build        跳过 npm install/build，只重新链接（要求 dist 已存在）
  --force           目标目录是真实目录时，备份后替换
  -y, --yes         非交互模式，缺少密钥时只警告
  -h, --help        显示帮助

环境变量:
  CLINE_PASS_API_KEY   未传 --key 时使用；已有凭据时会被复用
  XDG_CONFIG_HOME      默认 ~/.config

安装后:
  重启 opencode，输入 /cline-pass 打开仪表盘。
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --key)
      shift
      [ $# -gt 0 ] || { echo "缺少 --key 的值" >&2; exit 2; }
      KEY="$1"
      ;;
    --key=*)
      KEY="${1#*=}"
      ;;
    --no-key) NO_KEY=1 ;;
    --no-build) NO_BUILD=1 ;;
    --force) FORCE=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m安装失败:\033[0m %s\n' "$*" >&2; exit 1; }

step "检查运行环境"
command -v node >/dev/null 2>&1 || die "找不到 node。需要 Node.js >= 20.3。"
command -v npm >/dev/null 2>&1 || die "找不到 npm。"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a < 20 || (a === 20 && b < 3)) { console.error("需要 Node.js >= 20.3，当前 " + process.versions.node); process.exit(1); }' \
  || die "Node.js 版本过低"
ok "Node $(node -v) · npm $(npm -v)"

step "安装依赖并构建"
if [ "$NO_BUILD" -eq 1 ]; then
  [ -f "$ROOT/dist/index.js" ] || die "--no-build 需要先执行 npm run build"
  ok "跳过构建，使用现有 dist/"
else
  (cd "$ROOT" && npm install --no-audit --no-fund)
  (cd "$ROOT" && npm run build)
  ok "构建完成：$ROOT/dist"
fi
[ -f "$ROOT/server.js" ] || die "缺少根级 server.js（v2 目录插件入口）"
[ -f "$ROOT/dist/index.js" ] || die "缺少 dist/index.js"
(cd "$ROOT" && node --input-type=module -e "import('./dist/index.js').then((mod) => { if (!mod.default) { console.error('插件没有 default export'); process.exit(1); } })") \
  || die "插件入口无法加载"
ok "插件入口可加载"

step "注册到 opencode（v2 插件目录）"
mkdir -p "$PLUGIN_DIR"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if [ -L "$TARGET" ]; then
    rm -f "$TARGET"
  elif [ -d "$TARGET" ]; then
    if [ "$FORCE" -eq 1 ]; then
      backup="$TARGET.bak.$(date +%s)"
      mv "$TARGET" "$backup"
      warn "已备份原目录到 $backup"
    else
      die "$TARGET 是真实目录，不是本仓库的软链接。确认后加 --force 备份替换。"
    fi
  else
    if [ "$FORCE" -eq 1 ]; then
      rm -f "$TARGET"
    else
      die "$TARGET 已存在且不是目录/软链接；加 --force 覆盖。"
    fi
  fi
fi
ln -s "$ROOT" "$TARGET"
ok "插件目录：$TARGET -> $ROOT"

step "准备配置与凭据"
mkdir -p "$CONFIG_HOME"

if [ ! -e "$CONFIG_FILE" ]; then
  node - "$CONFIG_FILE" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const doc = {
  displayName: 'Cline Pass',
  baseURL: 'https://api.cline.bot/api/v1',
  apiKeyEnv: 'CLINE_PASS_API_KEY',
  accountMode: 'single',
  accounts: {},
  activeAccount: '',
  exposeTools: true,
  exposeCatalog: false,
  serverHost: '127.0.0.1',
  serverPort: 0,
  dashboard: true,
}
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
fs.chmodSync(file, 0o600)
NODE
  ok "已创建配置文件：$CONFIG_FILE"
else
  ok "保留现有配置：$CONFIG_FILE"
fi

has_key() {
  [ -f "$CREDENTIALS_FILE" ] || return 1
  node -e 'const fs=require("node:fs"); try { const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit(d && typeof d.CLINE_PASS_API_KEY === "string" && d.CLINE_PASS_API_KEY.length > 0 ? 0 : 1) } catch { process.exit(1) }' "$CREDENTIALS_FILE"
}

if [ -z "$KEY" ] && has_key; then
  ok "复用现有凭据：$CREDENTIALS_FILE"
fi

if [ -z "$KEY" ] && ! has_key && [ "$NO_KEY" -eq 0 ]; then
  if [ -t 0 ]; then
    printf '  请输入 Cline Pass API Key（输入不回显）: '
    IFS= read -r -s KEY || true
    printf '\n'
  elif [ "$ASSUME_YES" -eq 0 ]; then
    die "没有可用密钥。设置 CLINE_PASS_API_KEY、传 --key，或加 --no-key 只安装插件。"
  fi
fi

if [ -n "$KEY" ]; then
  node - "$CREDENTIALS_FILE" "$KEY" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [file, key] = process.argv.slice(2)
let doc = {}
try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {}
doc.CLINE_PASS_API_KEY = key
fs.mkdirSync(path.dirname(file), { recursive: true })
const tmp = file + '.tmp.' + process.pid
fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
fs.chmodSync(tmp, 0o600)
fs.renameSync(tmp, file)
NODE
  chmod 600 "$CREDENTIALS_FILE"
  ok "已写入凭据：${CREDENTIALS_FILE}（内容不回显）"
fi

step "校验文件权限与配置"
chmod 600 "$CONFIG_FILE" 2>/dev/null || true
chmod 600 "$CREDENTIALS_FILE" 2>/dev/null || true
node -e 'const fs=require("node:fs"); for (const f of process.argv.slice(1)) { if (fs.existsSync(f)) JSON.parse(fs.readFileSync(f,"utf8")); }' "$CONFIG_FILE" "$CREDENTIALS_FILE" \
  || die "配置或凭据文件不是合法 JSON"
[ "$(readlink "$TARGET" 2>/dev/null || true)" = "$ROOT" ] || die "插件软链接校验失败"
ok "配置/凭据 JSON 合法，权限为 0600"
ok "插件软链接指向正确"

step "安装完成"
cat <<EOF

  插件:     $TARGET
  配置:     $CONFIG_FILE
  凭据:     $CREDENTIALS_FILE
  仪表盘:   重启后输入 /cline-pass

下一步:
  1. 完全重启 opencode（让插件和 provider 重新加载）
  2. 在模型选择器中选择 cline-pass/...，或输入 /cline-pass 打开仪表盘
  3. 如果模型列表没变化，在 /cline-pass 的“模型可见性”里勾选模型

EOF
if ! has_key; then
  warn "还没配置密钥；重新运行 ./install.sh --key sk_... 或设置 CLINE_PASS_API_KEY。"
fi
