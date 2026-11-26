// 把「说明 + 源码 + 标准答案」拼成一份纯文本，方便直接投喂给其他 AI。
// 用法：node tools/build-ai-bundle.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  .trim()
  .replace(/^(#{1,5}) /gm, (m, hashes) => '#' + hashes + ' '); // 整体降一级，避免与本文档标题打架
const html = fs.readFileSync(path.join(root, '上海地铁计次票划算计算器.html'), 'utf8').trim();
const json = fs.readFileSync(path.join(root, '示例输出', 'scenarios.json'), 'utf8').trim();
const sha = crypto.createHash('sha256').update(html, 'utf8').digest('hex').toUpperCase();
const fence = '```';

const header = `# 上海地铁计次票划算计算器 · AI 交接单文件版

> 这份纯文本把「交接说明 + 工具源码 + 标准答案」放在一起，便于直接交给另一个 AI 完整理解这个工具。
> 同目录下的 \`上海地铁计次票划算计算器.html\` 就是可直接运行的工具本体，本文件附录 A 中的源码与它逐字一致。
> 源码 SHA-256：\`${sha}\`

## 目录

1. 交接说明（用途 / 口径 / 算法 / 结构 / 测试 / 边界）
2. 附录 A：完整 HTML 源码（单文件、离线、无外部依赖）
3. 附录 B：标准场景结算 JSON（可直接对照数字）
4. 附录 C：截图清单与复验命令
`;

const body = `
## 1. 交接说明

${readme}

## 2. 附录 A：完整 HTML 源码

单文件 ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB，包含 HTML、内联 CSS、内联 JS 与 2025–2027 节假日数据；核心算法在 \`/* CORE_START */\` 与 \`/* CORE_END */\` 之间。

${fence}html
${html}
${fence}

## 3. 附录 B：标准场景结算 JSON

由 \`node tools/dump-scenarios.mjs\` 生成。

${fence}json
${json}
${fence}

## 4. 附录 C：截图清单与复验命令

zip 包内 \`截图/\` 目录：

| 文件 | 内容 |
|---|---|
| mobile-full.jpg | 390px 宽移动端整页（新默认场景：22 工作日 / 44 次 / 不建议购买） |
| desktop-full.jpg | 1280px 宽桌面整页 |
| print.jpg | 打印 / 存 PDF 视图（表单与按钮隐藏） |
| calendar-dec-base.jpg | 日历：默认「纯刷卡」方案 |
| calendar-dec-45.jpg | 日历：切到「45 次卡」后的成本与逐日分解 |
| calendar-spring.jpg | 日历：2026-02-10 激活，含春节「节」与调休「班」标记 |

复验：

${fence}bash
node 测试/test.mjs                 # 期望 ALL TESTS PASSED
node 测试/interact.mjs             # 需要 Chrome，期望 ALL UI CHECKS PASSED（20 项）
node tools/dump-scenarios.mjs      # 重新生成附录 B
node tools/capture-calendar.mjs 2026-12-01 截图/out.png 2   # 截图：参数为 日期 输出 标签序号
${fence}

当前状态：两套测试均通过；390 / 320 / 1280 宽与打印视图均无横向溢出；脚本会自动定位同级/上级目录里的 HTML，不需要改路径。
`;

const out = path.join(root, '全部内容-AI单文件版.md');
fs.writeFileSync(out, header + body, 'utf8');
console.log(out, 'ok', (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
