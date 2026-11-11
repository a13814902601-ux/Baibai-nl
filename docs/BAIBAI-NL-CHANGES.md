# Baibai-nl 魔改明细（基于上游 ST-BaiBai-Image 0.3.2）

> 面向自然语言原生 ComfyUI 工作流（Flux / Qwen-Image 类模型）的个人分支。
> 上游：https://github.com/baibai-git/ST-BaiBai-Image

## 1. 工作流不再强制 %prompt%

`%prompt%`（英文 tag 注入位）与 `%nl%`（自然语言注入位）**至少保留其一**。自然语言工作流可以只写 `%nl%`。

改动位置：

- `src/backends/comfyui.ts` — `renderWorkflowTemplate` 校验放宽；`generateComfyImage` 允许 tag 为空而 nl 有内容
- `src/pages/backend/panels/ComfyUIPanel.vue` — 工作流「有效」药丸、AI 配置应用预览两处校验同步；提示文案更新
- `src/backends/comfyWorkflowAssistant.ts` — 系统提示词第 8 条改为「positive_tag / positive_nl / positive_combined 任一即可」；`applyWorkflowBindings` 的正向输入判定与渲染后校验同步

## 2. nl 输出改为完整中文自然语言提示词

开启工作流预设的「生成自然语言」开关后：

- `nl`（JSON 的 nl 键）按「可能被单独发送给生图模型」的标准书写，必须自足成画：人数与主体、区分性外貌锚点、服装款式与颜色、动作与互动（接触点具体）、表情与视线（具体中文描写）、场景与可见道具、光线色调、景别构图
- 角色名照抄正文/角色库原文（中文名保持中文）；同人角色可自然带出作品身份
- 角色固定外貌库字段写进 nl 时转写为等价自然中文（long black hair → 乌黑的长发），信息不增不减
- 多人画面保留三段式（总起 → 每人分述带区分性称谓 → 环境收尾）

改动位置：

- `src/state/settings.ts` — `DEFAULT_COMFY_NL_SPEC` 全文重写（中文）；`DEFAULT_COMFY_SPEC` 3 处措辞同步（「tag 用英文、nl 用中文」「库字段转写」等）；`DEFAULT_COMFY_THINKING` 新增 `{{#nl}}` 条件段（nl 落笔要求 + 落笔前自查）
- `src/autoTag/prompt.ts` — 输出示例的 nl 改中文；任务规则第 4 条、角色库照抄规则同步
- `src/pages/settings/index.vue` — 设置页 `{{nl}}` 宏说明同步

**不变**：tag 键仍为英文 danbooru 短 tag；NAI 后端全部不动（NAI 的 nl 仍为英文）；破限词不动；选图/建档/changes/上下文参考机制不动。关闭「生成自然语言」时行为与上游完全一致（条件段自动退回）。

## 3. NSFW 场景身体特写偏好

性行为/露骨亲密场景的取景以参与部位与接触点的特写/近景为主，确有需要才放宽到更远景别；可见部位与接触关系写具体，被完全遮住的部位不写成可见。两处生效：

- `DEFAULT_COMFY_NL_SPEC` 的「NSFW/亲密场景取景偏好」段
- `DEFAULT_COMFY_THINKING` 的「景别」槽位（不看自然语言开关，恒生效）

## 4. 移植本机手工补丁进源码

原维护者曾直接补在编译产物 `dist/index.js` 上、未进源码，重建即丢：

- **seedfix**：`randomSeed()` 上限 2^53 → 94967296（部分采样器包装/自定义节点对大整数种子兼容不佳）
- **thpatch**：`src/floor/hydrate.ts` 的 `findMesText` — Tweaks Hall 流式渲染把 `.mes_text` 标记为 `hidden!` 并改由 `.TH-streaming` 显示正文时，楼层卡片改挂 `.TH-streaming`

## 5. 修复上游自带失败测试

上游 0.3.2 的 `prompt.test.ts`「keeps fandom identity and NSFW checkpoints」在原版即失败：内置破限词（NVWA 文本）含「成年人」三字，与 NAI 分支的 `not.toContain('成年人')` 断言冲突。修法：断言前排除破限词消息（口径回到「NAI 思维链不得混入 ComfyUI 专属条款」的本意）。与功能无关。

## 验证状态

- `pnpm test`：59 文件 782 用例全过（3 跳过为上游原有）
- `pnpm build`：通过，产物含上述全部改动（逐项 grep 验证）
- 未在真实 SillyTavern / ComfyUI 环境回归（个人装机环境自测）
