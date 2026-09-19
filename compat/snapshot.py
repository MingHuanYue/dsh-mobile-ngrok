# 把「当前这一版可用的状态」整体快照下来，包含工作区外的改动。
#
# 为什么不能只备份 out\mingyue-dsh.apk：
#   之前"手机不显示"那次，根因在工作区【外】被改过的 DSH 前端产物里
#   （转译过的 client.js、注入过 polyfill 的 index.html）。
#   只留 APK 的话，前端那边回不去，等于备份是残的。
#
# 所以这里把四块一起快照：
#   ① APK 源码 + 资源（工作区内，改动源头）
#   ② 网关（工作区内）
#   ③ DSH 前端 dist（工作区外，含 polyfill 注入）
#   ④ 各客户端插件包 client.js（工作区外，含 esbuild 转译）
# 另外写一份 MANIFEST，记录每个文件的来源与大小，便于日后比对。
import os
import shutil
import subprocess
import sys
from datetime import datetime

import os
import sys

# 路径不写死：由同目录的 paths.py 自动定位（可用 MINGYUE_WS / DSH_NM 覆盖）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402

_BT = paths.buildtools_dir()

WS = paths.workspace_root()
APP = os.path.join(WS, "手机端")
GW = os.path.join(APP, "网关")
NM = paths.dsh_packages()
FRONTEND_DIST = os.path.join(NM, "dsh-web-frontend", "dist")

STAMP = datetime.now().strftime("%Y%m%d-%H%M%S")
OUT = os.path.join(WS, "_buildtools", "snapshots", STAMP)


def copy_tree(src, dst, skip=None):
    if not os.path.isdir(src):
        return 0
    n = 0
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", "node_modules")]
        for f in files:
            s = os.path.join(root, f)
            rel = os.path.relpath(s, src)
            if skip and skip(rel):
                continue
            d = os.path.join(dst, rel)
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copy2(s, d)
            n += 1
    return n


def main():
    os.makedirs(OUT, exist_ok=True)
    lines = []
    lines.append("快照时间: " + STAMP)
    lines.append("")

    # ① 应用源码与资源
    n = copy_tree(os.path.join(APP, "app"), os.path.join(OUT, "app"))
    lines.append("app/            -> %d 个文件（源码 + 资源 + 清单）" % n)

    # ② 构建脚本与文档
    for f in ("build-apk.ps1", "说明.md"):
        s = os.path.join(APP, f)
        if os.path.isfile(s):
            shutil.copy2(s, os.path.join(OUT, f))
    lines.append("build-apk.ps1 / 说明.md 已复制")

    # ③ 网关源码（不含 exe/日志/令牌）
    gwdst = os.path.join(OUT, "gateway")
    os.makedirs(gwdst, exist_ok=True)
    gn = 0
    for f in os.listdir(GW):
        if f in ("ngrok.exe", "手机网关控制台.exe", "_selftest.exe"):
            continue
        if f.endswith((".log", ".ini")) or f == "ngrok.yml" or f.startswith(".gateway-secret"):
            continue
        s = os.path.join(GW, f)
        if os.path.isfile(s):
            shutil.copy2(s, os.path.join(gwdst, f))
            gn += 1
    lines.append("gateway/        -> %d 个文件（已排除 exe / 日志 / ngrok.yml 令牌）" % gn)

    # ④ DSH 前端 dist（polyfill 注入在这里）
    dn = copy_tree(FRONTEND_DIST, os.path.join(OUT, "dsh-web-frontend-dist"))
    lines.append("dsh-web-frontend-dist/ -> %d 个文件（含注入的 polyfill）" % dn)

    # ⑤ 各客户端插件包的 client.js（转译结果）
    pdst = os.path.join(OUT, "client-bundles")
    os.makedirs(pdst, exist_ok=True)
    pn = 0
    for name in sorted(os.listdir(NM)):
        p = os.path.join(NM, name, "lib", "client.js")
        if os.path.isfile(p):
            d = os.path.join(pdst, name)
            os.makedirs(d, exist_ok=True)
            shutil.copy2(p, os.path.join(d, "client.js"))
            pn += 1
    lines.append("client-bundles/ -> %d 个客户端插件包" % pn)

    # ⑥ 记录 APK 信息
    apk = os.path.join(APP, "out", "mingyue-dsh.apk")
    if os.path.isfile(apk):
        shutil.copy2(apk, os.path.join(OUT, "mingyue-dsh.apk"))
        lines.append("mingyue-dsh.apk -> %.1f KB" % (os.path.getsize(apk) / 1024))

    # ⑦ 状态标记：此刻前端是否被改过
    lines.append("")
    lines.append("=== 本快照包含的“非官方改动” ===")
    idx = os.path.join(FRONTEND_DIST, "index.html")
    if os.path.isfile(idx):
        t = open(idx, encoding="utf-8").read()
        lines.append("  index.html 已注入 polyfill: %s" % ("是" if "data-mingyue-polyfill" in t else "否"))
    n_static = 0
    for name in sorted(os.listdir(NM)):
        p = os.path.join(NM, name, "lib", "client.js")
        if os.path.isfile(p):
            s = open(p, encoding="utf-8", errors="ignore").read()
            if "static{" in s:
                n_static += 1
    lines.append("  仍有类静态块(static{)的插件包: %d 个" % n_static)

    with open(os.path.join(OUT, "MANIFEST.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    print("\n".join("  " + l for l in lines))
    print()
    print("  快照目录: " + OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
