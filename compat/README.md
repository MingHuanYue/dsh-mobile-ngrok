# DSH 前端兼容层

让新版 DSH 前端能在旧内核的手机浏览器上跑起来。

---

## 为什么需要这个

DSH 的 Web 前端是按 Chromium 94 以上构建的。手机自带的内核往往达不到这个版本。

差距分两种情况，处理方式完全不同。

一种是语法层面的。前端 bundle 里用了类静态初始化块 `static{}`，
旧内核在**解析阶段**就抛 `SyntaxError`，整个 bundle 一行都不会执行。
这种情况 polyfill 救不了，只能转译成旧语法。

另一种是运行时层面的，比如 `Promise.withResolvers`、`AbortSignal.any`、
`structuredClone` 这些方法不存在。页面能正常解析，但运行到那里会报
`is not a function`。这种可以用 polyfill 补。

两件事都得做。

---

## 文件

| 文件 | 干什么的 |
|---|---|
| `legacy-polyfill.js` | 补缺失的运行时 API |
| `narrow-screen.css.js` | 窄屏下的排版修正 |
| `patch-gateway.py` | 入口脚本，把上面两个注入到 DSH 的前端里 |
| `inline-polyfill.py` | 另一种注入方式，备用 |
| `transpile-with-api.js` | 用 esbuild 把 bundle 转译到 es2021 |
| `fix-static-blocks.py` | 处理 esbuild 不肯降级的那个类静态块 |
| `snapshot.py` | 改动之前先备份，方便整体回滚 |

---

## 怎么跑

这些脚本改的是你电脑上已经装好的 DSH，也就是 `node_modules` 里的文件，
不是这个仓库里的东西。所以 DSH 升级之后要重跑一遍。

```bash
# 先备份
python compat/snapshot.py

# 如果 DSH 前端报 SyntaxError，先转译
node compat/transpile-with-api.js
python compat/fix-static-blocks.py

# 注入 polyfill 和排版修正
python compat/patch-gateway.py

# 重启 DSH
```

最后一步不能省。Node 的模块第一次被 import 之后就常驻内存了，
改了文件不重启的话跑的还是旧代码。这个坑踩过两次。

---

## 注入的位置

`patch-gateway.py` 改的是 `dsh-host-frontend-static` 里那个 `renderIndex`：

```js
return ctx.webServer.renderIndex(await readFile(distIndex, "utf8"))
  .replace(/<head(?:\s[^>]*)?>/i,
    (open) => `${open}<base href="/">${MINGYUE_HEAD}`);
```

顺序是这样的：先让 DSH 自己把脚本注入完，再把我们的东西插到 `<head>` 后面。

之所以要这个顺序，是因为 DSH 的 `renderIndex` 会往 `<head>` 后面追加一段内联脚本，
那段脚本里就用到 `structuredClone`。如果补丁排在它后面，那段脚本先跑，
方法还没补上，照样报错。

实测验证过：注入后 polyfill 在 `@64`，DSH 的脚本在 `@13307`，顺序是对的。

---

## 失效的时候会怎样

所有改动都是安全失效。

脚本找不到要处理的语法就跳过，polyfill 遇到已经存在的 API 不会覆盖，
CSS 选择器匹配不到就只是不生效。页面不会因此坏掉。

这是故意这么设计的。宁可没优化，也别把页面弄坏。

---

## 怎么回退

跑 snapshot 的时候会生成一个带时间戳的目录，里面有 MANIFEST.txt 记录当时的状态，
连工作区外的 DSH 前端文件也一起备份了，从那里整体还原就行。

只想还原某一个模块的话，`patch-gateway.py` 里引用的备份文件可以单独用。

---

## 关于那个 polyfill

`legacy-polyfill.js` 覆盖的 API，括号里是对应的 Chromium 版本：

- `Iterator` 和迭代器助手（122）
- `Promise.withResolvers`（119）
- `Object.groupBy`（117）
- `AbortSignal.any`（116）
- `Array.prototype.toSorted` 等（110）
- `structuredClone`（98）
- `Object.hasOwn`（93）
- `Array.prototype.at`（92）

每一段都单独包在 try/catch 里。这是因为最早把它们放在同一个 try 里的时候，
`Iterator` 那段一抛异常，后面的 API 全都补不上，排查了很久才找到。
