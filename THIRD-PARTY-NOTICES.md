# 第三方组件与许可

这个仓库自己的代码用 [MIT](LICENSE)。但它要跟一些第三方软件一起工作，
下面逐项说明各自的许可，以及为什么这些东西不放在仓库里。

---

## 引用了但没打包的

### DeepSeek Harness

主页：<https://github.com/deepseek-ai/deepseek-harness>

许可：MIT

这个项目做的就是让手机能用上 DSH，电脑端的网关是把 DSH 自带的 Web 界面转发给手机。

`compat/` 那部分脚本会在**你自己的电脑上**修改已安装的 DSH 前端产物
（`node_modules` 里的文件）。仓库里不包含这些被改过的文件，只包含能复现改动的脚本。

被引用到的 DSH 包，都是 MIT：

`@deepseek-ai/dsh-web-frontend`、`dsh-base`、`dsh-web-app`、
`dsh-host-frontend-static`、`dsh-host-webserver`

版本以你本地安装的为准。

> 如果将来有人把改过的 DSH 前端产物一起分发出去，那些产物仍然受 MIT 约束，
> 需要保留版权声明。这个仓库选择不附带它们，所以不涉及再分发的问题。

### dsh-whale-widget

仓库：<https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget>

许可：代码是 MIT，`assets/` 目录下的美术素材不适用 MIT。

它自己的 PROVENANCE.md 里写得很清楚：`assets/` 里的图片、动图、音效
「按原样随插件分发、仅供运行本插件使用，不授予再许可，也不声明为原创作品」。
其中 `DSniang1.png` 是 AI 工具生成的图像，生成工具和原始出处已不可考。

所以这个仓库不放那些素材。要用的话请从上游渠道（该插件的 npm 包或仓库）获取，
并自己判断使用场景合不合适。

---

## 明确不分发的

### ngrok

主页：<https://ngrok.com>

许可：专有软件，不是开源的。

它的作用是把本地网关暴露成一个临时公网地址，让不在同一个网络的手机能连上。

仓库里不放 `ngrok.exe`（32 MB），请从官方下载：<https://ngrok.com/download>

使用受 ngrok 的服务条款约束，需要自己的账号和令牌。免费额度对个人使用通常够，
具体以官网为准。

### Android SDK 和 JDK

编译 APK 需要 JDK，以及 Android SDK 的 build-tools（aapt2、d8、zipalign、apksigner）。

JDK 用的是 GPLv2 加 Classpath Exception，Android SDK 有自己的许可协议。
这两个加起来五百多 MB，仓库里不放，`android/build-apk.ps1` 会告诉你需要哪些。

### esbuild

只在用前端兼容层的时候需要。

许可：MIT

从 npm 拉取，仓库里不附带它的二进制。

---

## 仓库里不会有的东西

| 东西 | 原因 |
|---|---|
| `ngrok.yml` | 里面有 ngrok 的认证令牌，那是账号凭据 |
| `*.keystore` | APK 签名私钥。泄露意味着别人能用你的名义发更新 |
| 各种 API key、密码 | 同上 |
| `out/` 目录、`*.apk` | 构建产物，走 Release 而不是源码仓库 |
| 第三方二进制 | 见上文 |
| 没有授权的美术素材 | 见上文挂件那节 |

`.gitignore` 按这个清单逐条设了防。

---

## 如果这里有你认为侵权的内容

开一条 issue，说明具体是哪个文件、依据是什么，核实之后会立刻移除或替换，
不附加其他条件。

---

## 发布前自己过一遍

- [ ] `git status` 里没有 `ngrok.yml`、`*.keystore`、`*.apk`
- [ ] `git log -p` 里搜不到 `authtoken`、`private key` 之类的字符串
- [ ] 仓库里没有挂件 `assets/` 下的素材
- [ ] 没有第三方二进制
- [ ] `THIRD-PARTY-NOTICES.md` 里的链接和许可描述还是准确的
- [ ] 如果哪天真附带了 DSH 前端产物，记得同步保留它的 MIT 版权声明
