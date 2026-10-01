# dsh-open-code-review

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，把
[阿里 Open Code Review](https://github.com/alibaba/open-code-review) 的确定性评审引擎接入 DSH 智能体。

Open Code Review（OCR）的核心设计是分工：**不能出错的部分交给工程逻辑**——哪些文件在评审范围内、
每个文件适用哪些规则；**判断部分交给模型**。本插件保留这个分工，把判断侧换成**你自己的 DSH 模型**。
OCR 自己的 LLM 全程不会被调用，因此不需要配置第二家模型服务，**也不需要 API Key**。

```
ocr_review_scope  →  哪些改动文件可评审（确定性）
ocr_review_rules  →  这些文件适用哪些规则（确定性）
       你         →  读 diff、判断、带覆盖率地出报告
```

## 环境要求

| | |
|---|---|
| `ocr` | **1.9.0 及以上**——`--format json` 自 1.9.0 引入。已在 Windows x64 + 1.12.11 上验证。 |
| git | 2.41 及以上（OCR 通过 git 读取 diff）。 |
| DSH | 任意支持插件的版本。已在 DSH Desktop 0.1.7-rc.2 上验证。 |

## 安装

**1. 安装 `ocr` CLI。** 插件自身不会安装任何东西。

```sh
npm install --prefix "<DSH_HOME>/open-code-review" @alibaba-group/open-code-review
```

`<DSH_HOME>` 是 harness 数据根目录（环境变量 `$env:DSH_HOME`；默认 `~/.dsh`，
DSH Desktop 为 `%APPDATA%\dsh-desktop\harness`）。装到该前缀下，二进制正好落在插件默认
`vendorDir` 查找的位置。

全局安装 `npm install -g @alibaba-group/open-code-review` 同样可用——插件会在 `PATH` 上找到它，
Windows 下还会顺着 npm 的 `ocr.cmd` 垫片找到旁边的原生二进制。两者相比，插件自管的前缀更可预测。

**2. 安装插件。**

```sh
dsh plugin --profile web add dsh-open-code-review
```

尚未发布到 npm 时，可直接从本仓库安装：

```sh
dsh plugin --profile web add github:ashllll/dsh-open-code-review
```

本地检出也可以——`dsh plugin --profile web add <tgz 绝对路径>`。
注意：pnpm 会把**相对**路径按当前目录解析，而不是 profile 目录，所以请传绝对路径。

**3. 刷新页面。** 三个工具 `ocr_review_scope`、`ocr_review_rules`、`ocr_health` 即出现，
技能目录中会多出 `open-code-review`。

## 插件提供了什么

### 工具

| 工具 | 用途 |
|---|---|
| `ocr_review_scope` | 哪些改动文件可评审，以及取 diff 所需的 mode 与 ref 信息。可传 `commit`，或 `from`+`to`，都不传则评审工作区改动。 |
| `ocr_review_rules` | OCR 为指定路径解析出的评审规则，按规则内容分组，共用同一规则的文件只出现一次。规则正文即评审清单。 |
| `ocr_health` | 解析到了哪个 `ocr` 可执行文件、来自哪里、版本多少、是否满足最低版本；找不到时直接给出安装命令。 |

### 技能

`open-code-review` 承载完整工作流——解析范围、解析规则、用 git 读 diff、逐个文件评审、
输出带行号定位与覆盖率统计的报告。按需加载，因此常驻提示词只占几行。

### 关于「移植」

上游为其他四种宿主提供了同一套契约：[opencode 插件](https://github.com/alibaba/open-code-review/blob/main/plugins/open-code-review/opencode/open-code-review.ts)、
Claude Code 与 Kimi Code 的斜杠命令、以及两个可移植技能。本包是这套集成里 DSH 形态的那一个。
OCR 引擎没有任何重写——插件驱动的是真正的 `ocr` 二进制。

## 配置

插件以一个 patch 行挂载，暴露三个配置项：

```yaml
- id: open-code-review
  name: dsh-open-code-review
  config:
    vendorDir: !!js dshHomePath('open-code-review')   # 默认值
    ocrPath: ''                                       # 显式指定二进制或安装目录，优先级最高
    timeoutMs: 180000                                 # 单次调用超时（毫秒）
```

覆盖项写进你自己 profile 的 `cordis.patch.yml`
（`<DSH_HOME>/profiles/<name>/cordis.patch.yml`）。注意 DSH 对 `config` 是**整体替换而非深合并**，
想保留的字段要一并写出。只停用不卸载：

```yaml
- id: open-code-review
  disabled: true
```

## 范围说明

**有意未移植**：

- `ocr review` 与 `ocr scan`——LLM 驱动的评审流水线。它需要自己的模型服务与 API Key，
  而这正是委托模式要消除的东西。确实需要的话，自行配置 OCR 的 LLM
  （`ocr config provider`、`ocr config model`），再通过 `pwsh` 工具调用 CLI。
- `ocr viewer`、`ocr session *`、`ocr config *`——交互式或有状态的面板，没有合适的工具化契约。

自定义规则完全可用：在仓库里放 `.opencodereview/rule.json`，`ocr_review_rules` 会自动解析，
并在结果里标注 `source: project`。格式见
[OCR 规则文档](https://github.com/alibaba/open-code-review)。

## 安全

- **不隐式安装。** 插件从不联网。缺少二进制时会失败并给出确切命令。
- **不经 shell。** `ocr` 通过解析出的原生可执行文件以 `shell: false` 启动，模型传入的 ref 与路径
  不会被拼进命令行。npm 的 `.cmd` 垫片只当作路标用于定位原生二进制，不执行它——这同时跳过了
  启动器的后台更新检查。
- **委托模式只读。** `ocr delegate` 不写任何会话文件，只把一份 JSON 打到 stdout 后退出。
- **沙箱边界。** 插件直接以子进程方式启动 `ocr`，因此这次调用**不经过** DSH 的 shell 沙箱与审批门禁
  （`pwsh` 会经过）。它读取目标 git 仓库——文件名、状态、解析出的规则正文，不读取文件内容。
  请把 `repo` 指向你愿意被检查的仓库；若某 profile 不接受这一点，请停用本插件。
- **有界。** 10 MiB 输出上限、墙钟超时，超时或取消时终止整棵进程树（Windows 下含 `taskkill /T`）。

## 开发

```sh
node test/smoke.mjs
```

29 项检查，覆盖参数构建、各种 npm 目录布局下的二进制解析、委托 JSON 解析、frontmatter 处理。
当能解析到 `ocr` 时，还会跑真实链路：`ocr version`、针对临时 git 仓库的 `delegate preview`、
以及解析 Python 规则集的 `delegate rule`。没有 `ocr` 时这三项报告为 skipped，而不是失败。

## 许可

Apache-2.0。部分内容派生自
[alibaba/open-code-review](https://github.com/alibaba/open-code-review)；
复用了什么、改了什么，见 [NOTICE](NOTICE)。本项目与阿里巴巴集团无隶属或背书关系。
