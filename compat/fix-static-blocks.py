# 处理 PDF.js 里那个 esbuild 拒绝降级的类静态块（最后方案）。
#
# 前面失败三次，根因都是同一个：这个文件里模板字符串/代码片段极多，
# 里面的 } 会骗过简单的括号匹配。所以这次不配对括号 —— 改用
# 【严格正则】：只匹配 static{ 之后不含任何引号或花括号的纯表达式块，
# 并限定长度上限。匹配不到就明确报错，绝不瞎改。
import os
import re
import shutil
import subprocess
import sys

import os
import sys

# 路径不写死：由同目录的 paths.py 自动定位（可用 MINGYUE_WS / DSH_NM 覆盖）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths  # noqa: E402

_BT = paths.buildtools_dir()

PKG = paths.pkg("dsh-client-ui-sidebar-documentpreview")
TARGET = os.path.join(PKG, "lib", "client.js")
ORIG_BACKUP = os.path.join(_BT, "client-bundles-backup", "dsh-client-ui-sidebar-documentpreview", "client.js")
ESBUILD = os.path.join(_BT, "esbuild", "esbuild.exe")
TMP = os.path.join(_BT, "esbtest")

# 静态块内容：允许双引号字符串，但【不含花括号和反引号】。
# 为什么这么限：这个文件里模板字符串极多，{ } 会骗过括号配对。
# 实测那处静态块（WorkerMessageHandler）就是纯表达式 + 双引号字符串，
# 所以这条正则正好命中，同时杜绝误匹配到别处。
SAFE = re.compile(r'static\{((?:"[^"]*"|[^"`{}]){1,4000})\}')


def main():
    if not os.path.isfile(ORIG_BACKUP):
        print("!! 没有原始备份")
        return 1
    os.makedirs(TMP, exist_ok=True)
    shutil.copy2(ORIG_BACKUP, TARGET)

    # 1) esbuild 骨架
    out = os.path.join(TMP, "esb.js")
    r = subprocess.run([ESBUILD, TARGET, "--target=es2021", "--minify", "--format=esm",
                        "--charset=utf8", "--log-level=error", "--outfile=" + out],
                       capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        print("!! esbuild 失败")
        return 1
    src = open(out, encoding="utf-8").read()
    print("[1] 转译完成 %.2f MB，static{}=%d"
          % (len(src) / 1048576, len(re.findall(r"static\s*\{", src))))

    matches = list(SAFE.finditer(src))
    print("[2] 严格正则匹配到 %d 个可安全改写的静态块" % len(matches))
    if not matches:
        print("!! 匹配不到，说明静态块里含引号或花括号 —— 本脚本不处理，避免改坏。")
        print("   当前文件保持 esbuild 转译结果（那 1 处静态块仍在）。")
        open(TARGET, "w", encoding="utf-8").write(src)
        return 2

    # 从后往前替换。
    #
    # 关键：把新代码【原地】替换掉 static{...}，不做"删除+在类结尾插入"——
    # 前面几版就是栽在按删除长度换算偏移上。原地替换不涉及任何偏移计算。
    # 类体里 `;` 和 `try{}.call(X)` 都是合法语句，位置语义也一致
    # （静态块在类初始化时执行；这里变成类定义完成后立即执行）。
    for m in reversed(matches):
        body = m.group(1)
        cls = None
        for c in re.finditer(r"class\s+([A-Za-z_$][\w$]*)", src[:m.start()]):
            cls = c.group(1)
        if cls is None:
            print("!! 找不到所属类")
            return 1
        inject = ";try{(function(){" + body + "}).call(" + cls + ")}catch(e){};"
        src = src[:m.start()] + inject + src[m.end():]
        print("    改写 %s（%d 字，原地替换）" % (cls, len(body)))

    left = len(re.findall(r"static\s*\{", src))
    print("[3] 剩余 static{}=%d" % left)

    chk = TMP + r"\check.mjs"
    open(chk, "w", encoding="utf-8").write(src)
    r = subprocess.run(["node", "--check", chk], capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        print("!! 语法自检失败，放弃（不写入）:")
        print((r.stderr or "")[:400])
        return 1
    print("[4] 语法自检通过")
    open(TARGET, "w", encoding="utf-8").write(src)
    print("[ok] 写入 %.2f MB" % (len(src) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
