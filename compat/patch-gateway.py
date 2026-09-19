# 给 DSH 静态服务模块打补丁：注入 polyfill + 窄屏排版修正 CSS。
#
# 两样都必须在 DSH 自己往 <head> 注入脚本【之前】生效，
# 所以做法是：先让 renderIndex 注入完，再把我们的东西插到 <head> 紧跟之后。
#
# 为什么改这个文件而不是写 DSH 插件：写插件要装包、改 profile bundles、
# 跑 pnpm 安装，链路长且在用户机器上更容易出岔子。改一处更好回滚。
# 备份在 dsh-frontend-static-index.js.bak，随时可还原。
import json
import os
import shutil
import subprocess
import sys

import os
import sys

# 路径不写死：由同目录的 paths.py 自动定位（可用 MINGYUE_WS / DSH_NM 覆盖）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402

_BT = paths.buildtools_dir()

TARGET = os.path.join(paths.pkg("dsh-host-frontend-static"), "lib", "index.js")
BACKUP = os.path.join(_BT, "dsh-frontend-static-index.js.bak")
POLYFILL = os.path.join(_BT, "polyfills", "legacy-polyfill.js")
NARROW_CSS = os.path.join(_BT, "polyfills", "narrow-screen.css.js")

ORIGINAL_LINE = '\t\treturn ctx.webServer.renderIndex(await readFile(distIndex, "utf8")).replace(/<head(?:\\s[^>]*)?>/i, (open) => `${open}<base href="/">`);'


def read_css():
    """从 narrow-screen.css.js 里把两段 CSS 抠出来（不引入它的 export 语法）。"""
    src = open(NARROW_CSS, encoding="utf-8").read()
    out = []
    for name in ("NARROW_DIALOG_CSS", "WHALE_SMALLER_CSS"):
        marker = "export const " + name + " = `"
        i = src.find(marker)
        if i < 0:
            raise SystemExit("  !! CSS 文件里找不到 " + name)
        i += len(marker)
        j = src.find("`;", i)
        if j < 0:
            raise SystemExit("  !! " + name + " 没有结束反引号")
        out.append(src[i:j])
    return "\n".join(out)


def main():
    if not os.path.isfile(TARGET):
        print("  !! 目标不存在"); return 1

    if not os.path.isfile(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print("  [ok] 备份 -> " + BACKUP)
    else:
        # 每次都从备份重建，保证可重复运行
        shutil.copy2(BACKUP, TARGET)

    src = open(TARGET, encoding="utf-8").read()
    if ORIGINAL_LINE not in src:
        print("  !! 找不到原始那一行，中止")
        print("     期望: " + ORIGINAL_LINE[:110])
        return 1

    poly = open(POLYFILL, encoding="utf-8").read()
    css = read_css()

    head_js = ('`<script data-mingyue-polyfill>${MINGYUE_POLYFILL}</script>'
               '<style data-mingyue-narrow>${MINGYUE_CSS}</style>`')

    new = (
        '\t\t// ---- DSH 手机端注入层（2026-09-19）----\n'
        '\t\t// ① polyfill：手机 WebView 缺 Promise.withResolvers / AbortSignal.any 等\n'
        '\t\t// ② 窄屏 CSS：修正 DSH 设置对话框在小屏下被挤成竖排的问题，并把鲸鱼默认缩小\n'
        '\t\t// 顺序关键：必须排在 DSH 自己注入的脚本之前，否则那些脚本先跑就先报错。\n'
        '\t\tconst MINGYUE_POLYFILL = ' + json.dumps(poly) + ';\n'
        '\t\tconst MINGYUE_CSS = ' + json.dumps(css) + ';\n'
        '\t\tconst MINGYUE_HEAD = ' + head_js + ';\n'
        '\t\treturn ctx.webServer.renderIndex(await readFile(distIndex, "utf8"))\n'
        '\t\t\t.replace(/<head(?:\\s[^>]*)?>/i, (open) => `${open}<base href="/">${MINGYUE_HEAD}`);'
    )

    out = src.replace(ORIGINAL_LINE, new, 1)
    if out == src:
        print("  !! 替换没生效"); return 1

    tmp = TARGET + ".chk.mjs"
    open(tmp, "w", encoding="utf-8").write(out)
    r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True, errors="replace")
    os.remove(tmp)
    if r.returncode != 0:
        print("  !! 语法错误，放弃:")
        print("  " + (r.stderr or "")[:400])
        return 1
    print("  [ok] 语法自检通过")

    open(TARGET, "w", encoding="utf-8").write(out)
    print("  [ok] 已写入  (polyfill %d 字节, CSS %d 字节)" % (len(poly), len(css)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
