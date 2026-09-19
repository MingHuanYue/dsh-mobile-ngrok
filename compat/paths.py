"""路径解析：把「开发机的绝对路径」换成「能自动找到的路径」。

背景
----
compat/ 下这几个脚本原本写着开发机的绝对路径，别人 clone 下来跑不起来。
这里统一处理，规则是：

  工作区根       优先读 MINGYUE_WS，读不到就从本文件位置往上推两级
  构建工具目录   工作区根/_buildtools
  DSH 的包目录   优先读 DSH_NM，否则在几个常见安装位置里挨个试

DSH 的安装位置因装法而异，常见的三种都试一遍：
  1. ~/.dsh/profiles/node_modules/@deepseek-ai     （DSH 自己管的 profile）
  2. npm 全局：%APPDATA%/npm/node_modules/@deepseek-ai
  3. npx 缓存：~/.npm/_npx/*/node_modules/@deepseek-ai

找不到就明确报错说清楚去哪儿找，不要静默用一个错的路径。
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def _first_dir(*candidates):
    for c in candidates:
        if c and os.path.isdir(c):
            return c
    return None


def workspace_root():
    """工作区根目录。"""
    env = os.environ.get("MINGYUE_WS")
    if env and os.path.isdir(env):
        return env
    # compat/ 在仓库里，仓库又在工作区里，所以往上两级
    return os.path.dirname(os.path.dirname(_HERE))


def buildtools_dir():
    return os.path.join(workspace_root(), "_buildtools")


def dsh_packages():
    """DSH 各包所在的 node_modules/@deepseek-ai 目录。"""
    env = os.environ.get("DSH_NM")
    if env and os.path.isdir(env):
        return env

    home = os.path.expanduser("~")
    cands = [
        os.path.join(home, ".dsh", "profiles", "node_modules", "@deepseek-ai"),
        os.path.join(os.environ.get("APPDATA", ""), "npm", "node_modules", "@deepseek-ai"),
    ]

    # npx 缓存：目录名是哈希，得挨个看
    npx = os.path.join(home, ".npm", "_npx")
    if os.path.isdir(npx):
        for d in os.listdir(npx):
            cands.append(os.path.join(npx, d, "node_modules", "@deepseek-ai"))

    found = _first_dir(*cands)
    if found:
        return found

    sys.stderr.write(
        "找不到 DSH 的安装位置。请用环境变量指定，例如：\n"
        "    set DSH_NM=C:\\Users\\你\\.dsh\\profiles\\node_modules\\@deepseek-ai\n"
        "已试过这些位置：\n" + "\n".join("    " + c for c in cands) + "\n"
    )
    raise SystemExit(2)


def pkg(name):
    """取某个 DSH 包的目录。"""
    return os.path.join(dsh_packages(), name)


if __name__ == "__main__":
    print("工作区根  :", workspace_root())
    print("构建工具  :", buildtools_dir())
    try:
        print("DSH 包目录:", dsh_packages())
    except SystemExit:
        pass
