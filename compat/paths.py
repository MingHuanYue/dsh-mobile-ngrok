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
    """找「构建工具」目录。

    实测出来的问题：原来只是简单地拼 `工作区根/_buildtools`，
    目录不存在也照拼不误 —— 脚本会拿着一个不存在的路径继续跑，
    最后报一个「文件找不到」的错，让人搞不清到底缺什么。
    用户从 Release 里解压出来的包里根本没有 _buildtools，
    所以这个提示必须清楚。

    现在多了两个候选位置，都找不到就明确报错并说明怎么解决。
    """
    env = os.environ.get("MINGYUE_BUILDTOOLS")
    if env:
        if os.path.isdir(env):
            return env
        sys.stderr.write(
            "环境变量 MINGYUE_BUILDTOOLS 指向的目录不存在：\n    %s\n" % env
        )

    root = workspace_root()
    cands = [
        os.path.join(root, "_buildtools"),
        os.path.join(root, "buildtools"),
        os.path.join(os.path.dirname(_HERE), "_buildtools"),  # 仓库同级
    ]
    found = _first_dir(*cands)
    if found:
        return found

    sys.stderr.write(
        "找不到构建工具目录（_buildtools）。\n"
        "这个目录里有 polyfill 和 CSS 的源文件，本仓库不附带它们。\n"
        "\n"
        "两种解决办法：\n"
        "  1. 如果你是从 Release 解压的：构建脚本是给改代码的人用的，\n"
        "     普通使用不需要它。直接把网关卡和手机 App 用起来就行。\n"
        "  2. 如果你在改代码：把 _buildtools 放在工作区根目录下，\n"
        "     或者用环境变量指过去：\n"
        "        set MINGYUE_BUILDTOOLS=D:\\你的目录\\_buildtools\n"
        "\n"
        "已试过这些位置：\n" + "\n".join("    " + c for c in cands) + "\n"
    )
    raise SystemExit(2)


def dsh_packages():
    """DSH 各包所在的 node_modules/@deepseek-ai 目录。"""
    env = os.environ.get("DSH_NM")
    if env:
        if os.path.isdir(env):
            return env
        # 设了但指错了，要说出来 —— 否则用户以为生效了，
        # 实际脚本悄悄用了别的路径，出问题根本查不到原因。
        sys.stderr.write(
            "警告：环境变量 DSH_NM 指向的目录不存在，将改为自动查找。\n"
            "    %s\n" % env
        )

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
        "找不到 DSH 的安装位置。\n"
        "这几个脚本要改你电脑上已经装好的 DSH，所以得先装 DSH。\n"
        "\n"
        "如果 DSH 装在别处，用环境变量指过去：\n"
        "    set DSH_NM=C:\\Users\\你\\.dsh\\profiles\\node_modules\\@deepseek-ai\n"
        "\n"
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
