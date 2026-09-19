// 窄屏下修正 DSH 设置对话框的排版。
//
// 问题（实测数据，375px 视口）：
//   对话框 maxWidth = 327px
//   ├── 左导航  w = 188px  flex: 0 0 auto   ← 写死宽度，吃掉 57%
//   └── 右内容  w = 139px  flex: 1 1 0%    ← 只剩 43%
//   结果：右栏里的文字（"语言"、"浅色/深色/跟随系统"）被挤成一个字一行。
//
// 修法：窄屏时把左导航压窄、给右内容一个最小宽度。
// 用 [class*="..."] 属性选择器匹配 —— DSH 的类名带构建期哈希前缀
// （实测是 VOzbGW_），前缀一变就失效，所以只匹配稳定的中段部分。
//
// ⚠️ 这段样式依赖 DSH 的样式变体：如果 DSH 升级后换了类名，
// 它只是不再生效（不会报错、不会把页面弄坏）—— 属于安全失效。
export const NARROW_DIALOG_CSS = `
/* 仅在窄屏（手机竖屏）下生效，宽屏保持 DSH 原样 */
@media (max-width: 520px) {
  /*
    左导航宽度。

    这里改过三次，把过程记下来：
      ① 原样 188px  → 右栏被挤到 139px，文字竖排
      ② 我压到 96px → 右栏好了，但导航标签被截断成「通..」「模..」「A...」
      ③ 现在 120px  → 两边都够用

    为什么是 120：真机实测每个标签需要 56px（最长的是「Agent 预设」，
    加图标 16px + 间距 8px），左右内边距各 6px，算下来约 84px 起；
    实测 112px 时「Agent 预设」仍被截（可用 48 vs 需要 55），
    120px 时全部 need=56 / w=56，无一截断。
    而且因为同时放宽了外框，右栏反而从 257px 变成 280px —— 比 96px 那版更宽。

    教训：这是我第二次在"窄屏适配"上把某一栏压过头。
    定这种数值要量（need 与 w 对比），不能凭感觉。
  */
  [class*="_panel"] > [class*="_nav"] {
    flex: 0 0 120px !important;
    width: 120px !important;
    min-width: 120px !important;
    max-width: 120px !important;
    padding-left: 6px !important;
    padding-right: 6px !important;
  }
  /* 导航里的文字略缩，窄栏里也放得下 */
  [class*="_panel"] > [class*="_nav"] * {
    font-size: 11px !important;
  }
  /* 右内容保底宽度：这是解决"竖排文字"的关键 */
  [class*="_panel"] > [class*="_content"] {
    flex: 1 1 auto !important;
    min-width: 200px !important;
  }
  /* 对话框整体可以再宽一点（不超出视口） */
  [class*="_panel"] {
    max-width: calc(100vw - 24px) !important;
  }
  /*
    字号收敛。用户反馈"字体勉勉强强，还是大了点" ——
    右栏整体调小一档，并把标题/说明的默认大字也压下来。
    用通配选择器会误伤，所以只作用于右内容区内部。
  */
  [class*="_panel"] > [class*="_content"] {
    font-size: 13px !important;
  }
  [class*="_panel"] > [class*="_content"] h1,
  [class*="_panel"] > [class*="_content"] h2,
  [class*="_panel"] > [class*="_content"] h3 {
    font-size: 15px !important;
    line-height: 1.35 !important;
  }
  [class*="_panel"] > [class*="_content"] p,
  [class*="_panel"] > [class*="_content"] li,
  [class*="_panel"] > [class*="_content"] label,
  [class*="_panel"] > [class*="_content"] span,
  [class*="_panel"] > [class*="_content"] button {
    font-size: 13px !important;
  }
  /* 行高收紧一点，同样高度里能多放内容 */
  [class*="_panel"] > [class*="_content"] {
    line-height: 1.45 !important;
  }

  /*
    设置行的标签列。

    真机实测（在你的手机上直接量的）：每一行的标签容器
        .bVCLcG_rowText  宽 99px，padding-right: 48px
    也就是说 99px 里有一半被内边距吃掉，文字只剩 51px ——
      「字号大小」折 2 行
      「仅影响会话内容的字号」折 3 行
      「繁忙时的发送行为」折 4 行
      「智能体运行时 Enter 键…」折到 10 行

    把右内边距压到 8px、并给个最小宽度，实测：
      字号大小 → 1 行，仅影响会话内容 → 2 行，繁忙时的发送行为 → 2 行。
    这段是在你手机上现场注入验证过效果才写进来的。
  */
  [class*="_rowText"] {
    padding-right: 8px !important;
    min-width: 60px !important;
  }
  [class*="_row"] {
    gap: 6px !important;
  }
  [class*="_title"] {
    font-size: 13px !important;
  }
}
`;

// 鲸鱼挂件：只停掉那个无限循环的彩虹动画，其余一概不碰。
//
// ⚠️ 这里踩了一个大坑，记下来：
//   上一版我顺手加了 `--dshw-scale: 0.7 !important` 和一个覆盖所有子元素的
//   `animation-name: none !important`。结果用户反馈「鲸鱼不跟手、大小调不了」——
//   因为 !important 的样式表规则会【压过元素自己的内联样式】，
//   而挂件正是用内联样式在拖拽时改位置、在拉滑块时改 --dshw-scale。
//   于是它自己的每一次更新都被我盖掉：拖不动、调不小。
//
//   教训：第三方组件的动态状态（拖拽位置、缩放倍率）绝不能从外部用
//   !important 锁死。想改默认值就改它的配置，不要用 CSS 硬压。
//
// 现在只做一件事：停掉那个一直跑的马灯动画。作用对象用具体的类名，
// 不用通配符，避免误伤挂件自己靠动画驱动的交互效果。
export const WHALE_SMALLER_CSS = `
/* 只针对"跑马灯渐变"那三行文字：类名是 .dshwv-rgb / .dshwv-bgrgb，
   它们带 dshwvRainbow 这个无限动画。停掉它 —— 渐变配色还在，
   只是不再流动，视觉上几乎无差别，但省掉了每帧重绘。 */
.dshwv-trow.dshwv-rgb,
.dshwv-trow.dshwv-bgrgb {
  animation-name: none !important;
}

/* 注意：不设 --dshw-scale。
   鲸鱼大小交给挂件自己的菜单滑块 —— 用户要用它，不能锁。
   想要小一点，请在挂件菜单里拉滑块，或在 DSH 侧调它的配置。 */
`;
