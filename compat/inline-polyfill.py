# 把 polyfill 以「字符串字面量」的形式内联进 dsh-host-frontend-static。
#
# 为什么不读外部文件：那个模块的 import 里没有 fileURLToPath，运行时算路径
# 依赖相对解析，容易在别的环境下失效。内联成字面量最稳，也不怕文件被挪走。
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

PKG = paths.pkg("dsh-host-frontend-static")
TARGET = os.path.join(PKG, "lib", "index.js")
POLYFILL = os.path.join(_BT, "polyfills", "legacy-polyfill.js")
BACKUP = os.path.join(_BT, "dsh-frontend-static-index.js.bak")

OLD = '\t\treturn ctx.webServer.renderIndex(await readFile(distIndex, "utf8")).replace(/<head(?:\\s[^>]*)?>/i, (open) => `${open}<base href="/">`);'


def build_new(polyfill_source):
    # 用 JSON 编码成安全的 JS 字符串字面量
    literal = json.dumps(polyfill_source)
    return (
        '\t\t// 老内核（Android WebView 91 / 鸿蒙 ArkWeb 等）缺运行时 API，'
        '这里注入 polyfill。\n'
        '\t\t// 语法层（类静态块）已由 esbuild 转译解决，这里补的是运行时方法。\n'
        '\t\tconst MINGYUE_POLYFILL = ' + literal + ';\n'
        '\t\treturn ctx.webServer.renderIndex(await readFile(distIndex, "utf8"))\n'
        '\t\t\t.replace(/<head(?:\\s[^>]*)?>/i, (open) => '
        '`${open}<base href="/"><script data-mingyue-polyfill>${MINGYUE_POLYFILL}</script>`);'
    )


def main():
    if not os.path.isfile(TARGET):
        print("!! 目标不存在: " + TARGET)
        return 1
    if not os.path.isfile(POLYFILL):
        print("!! polyfill 不存在: " + POLYFILL)
        return 1

    # 备份只做一次
    if not os.path.isfile(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print("[ok] 备份 -> " + BACKUP)

    # 从备份取原文（保证可重复运行）
    src = open(BACKUP, encoding="utf-8").read()

    if OLD not in src:
        print("!! 备份里找不到原始那一行，中止")
        print("   期望: " + OLD[:100])
        return 1

    polyfill = open(POLYFILL, encoding="utf-8").read()
    out = src.replace(OLD, build_new(polyfill), 1)
    if out == src:
        print("!! 替换未生效")
        return 1

    # 语法自检
    tmp = TARGET + ".check.mjs"
    open(tmp, "w", encoding="utf-8").write(out)
    r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    os.remove(tmp)
    if r.returncode != 0:
        print("!! 语法错误，放弃：")
        print((r.stderr or "")[:600])
        return 1
    print("[ok] 语法自检通过")

    open(TARGET, "w", encoding="utf-8").write(out)
    print("[ok] 已写入（polyfill %d 字节内联）" % len(polyfill))

    # 清掉上一次留下的外部文件
    ext = os.path.join(PKG, "lib", "legacy-polyfill.js")
    if os.path.isfile(ext):
        os.remove(ext)
        print("[ok] 清掉上一次的外部 polyfill 文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
