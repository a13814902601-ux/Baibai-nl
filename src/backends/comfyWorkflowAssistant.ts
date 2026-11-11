import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import {
  getWorkflowPlaceholders,
  parseWorkflowTemplate,
  type ComfyWorkflow,
} from '@/backends/comfyui';
import { getTagGenChannel } from '@/state/settings';

export type WorkflowBindingPurpose =
  | 'positive_tag'
  | 'positive_nl'
  | 'positive_combined'
  | 'negative'
  | 'seed'
  | 'width'
  | 'height';

export interface WorkflowBinding {
  node: string;
  input: string;
  purpose: WorkflowBindingPurpose;
  /** 需要跨每张图保留的原提示词片段编号；文本由插件按编号读取，AI不复制原文。 */
  keep?: string[];
}

export interface WorkflowChange extends WorkflowBinding {
  before: string | number;
  after: string;
}

export interface WorkflowAssistResult {
  workflow: string;
  changes: WorkflowChange[];
  nlMode: 'none' | 'separate' | 'combined';
  hasNegative: boolean;
}

const PURPOSES = new Set<WorkflowBindingPurpose>([
  'positive_tag',
  'positive_nl',
  'positive_combined',
  'negative',
  'seed',
  'width',
  'height',
]);

const SYSTEM_PROMPT = `你是 ComfyUI API 格式工作流的动态参数定位器。你只负责判断现有节点的哪个 inputs 字段承担什么用途，不得重写工作流。

只返回一个 JSON 对象，不要 Markdown、解释或思维过程：
{"bindings":[{"node":"6","input":"text","purpose":"positive_combined","keep":["F1","F2"]}]}

purpose 只能是：
- positive_tag：正向 danbooru/tag 提示词输入。
- positive_nl：与 tag 分开的自然语言正向输入。
- positive_combined：同一个文本输入同时接收 tag 与自然语言；原值同时包含逗号 tag 和完整句子，或该模型用同一编码器接收两者时选择此项。
- negative：负面提示词输入。
- seed：主生成链使用的随机种子。
- width / height：主生成画布或初始 latent 的宽高。

规则：
1. node 和 input 必须逐字对应工作流中真实存在的节点 ID 与 inputs 键。
2. 只选择值为字符串或数字的可编辑输入，不得选择形如 ["节点ID", 输出序号] 的连线数组。
3. 同一输入只能选择一个 purpose；tag 与自然语言共用时必须选 positive_combined。
4. 可以返回多个同用途输入，例如双编码器、多个同步 seed。
5. 不要选择模型名、LoRA、采样步数、CFG、采样器、调度器、放大/裁剪/预览尺寸。
6. width/height 只标记主生成尺寸，不标记后期放大、裁剪或输出尺寸。
7. 文本输入会提供 fragments。keep 只能填写该输入中需要跨所有图片永久保留的片段 ID：
   - 正向保留质量词、模型/LoRA触发词、固定风格词、固定评级词。
   - 正向删除导出示例里的角色数量、人物外貌、服装、动作、场景、构图、光线和自然语言画面描述。
   - 同一风格已由简短触发词表达时，不再保留自然语言中的重复风格句。
   - 负向保留通用质量、解剖、伪影和固定风格排除词；删除只针对导出示例人物或场景的临时排除词。
   - 不得复制片段文本，只返回 ID；没有固定片段就返回空数组。seed/width/height 的 keep 必须为空数组。
8. 至少必须找到一个正向提示词输入：positive_tag、positive_nl、positive_combined 任一均可（自然语言原生工作流允许只有 positive_nl）。无法可靠确认的输入不要猜。`;

interface PromptFragment {
  id: string;
  text: string;
}

const KNOWN_PLACEHOLDER_PATTERN = /%(?:prompt|negative_prompt|seed|nl|width|height)%/g;

function promptFragments(value: string): PromptFragment[] {
  return value
    .replace(KNOWN_PLACEHOLDER_PATTERN, '')
    .split(/[,，;；\r\n]+/)
    .map(text => text.trim())
    .filter(Boolean)
    .map((text, index) => ({ id: `F${index + 1}`, text }));
}

function workflowAnalysisPayload(workflow: ComfyWorkflow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(workflow).map(([nodeId, node]) => {
      const inputs =
        node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs)
          ? Object.fromEntries(
              Object.entries(node.inputs as Record<string, unknown>).map(([input, value]) => [
                input,
                typeof value === 'string'
                  ? { kind: 'text', fragments: promptFragments(value) }
                  : value,
              ]),
            )
          : node.inputs;
      return [
        nodeId,
        {
          class_type: node.class_type,
          title:
            node._meta && typeof node._meta === 'object' && !Array.isArray(node._meta)
              ? (node._meta as Record<string, unknown>).title
              : undefined,
          inputs,
        },
      ];
    }),
  );
}

function jsonObjects(raw: string): string[] {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const candidates = [cleaned];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.unshift(match[1].trim());
  }
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        candidates.push(cleaned.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

export function parseWorkflowBindings(raw: string): WorkflowBinding[] {
  let parsed: unknown;
  for (const candidate of jsonObjects(raw)) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // 尝试下一个 JSON 候选。
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI 没有返回可解析的工作流定位 JSON');
  }
  const bindings = (parsed as Record<string, unknown>).bindings;
  if (!Array.isArray(bindings)) throw new Error('AI 返回结果缺少 bindings 数组');

  const byPath = new Map<string, WorkflowBinding>();
  for (const item of bindings) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const node = typeof value.node === 'string' ? value.node.trim() : '';
    const input = typeof value.input === 'string' ? value.input.trim() : '';
    const purpose = typeof value.purpose === 'string' ? value.purpose.trim() : '';
    const keep = Array.isArray(value.keep)
      ? value.keep
          .filter((id): id is string => typeof id === 'string')
          .map(id => id.trim().toUpperCase())
          .filter(id => /^F\d+$/.test(id))
      : [];
    if (!node || !input || !PURPOSES.has(purpose as WorkflowBindingPurpose)) continue;
    const next = { node, input, purpose: purpose as WorkflowBindingPurpose, keep: [...new Set(keep)] };
    const key = `${node}\u0000${input}`;
    const previous = byPath.get(key);
    if (!previous || previous.purpose === next.purpose) {
      byPath.set(key, next);
      continue;
    }
    const positivePair = new Set([previous.purpose, next.purpose]);
    if (
      positivePair.has('positive_combined') ||
      (positivePair.has('positive_tag') && positivePair.has('positive_nl'))
    ) {
      byPath.set(key, {
        node,
        input,
        purpose: 'positive_combined',
        keep: [...new Set([...(previous.keep ?? []), ...(next.keep ?? [])])],
      });
      continue;
    }
    throw new Error(`AI 为节点 ${node}.${input} 返回了互相冲突的用途`);
  }
  return [...byPath.values()];
}

function appendComma(base: string, marker: string): string {
  const trimmed = base.trim();
  if (!trimmed) return marker;
  if (trimmed.includes(marker)) return trimmed;
  return `${trimmed.replace(/[\s,，]+$/, '')}, ${marker}`;
}

function appendLine(base: string, marker: string): string {
  const trimmed = base.trim();
  if (!trimmed) return marker;
  if (trimmed.includes(marker)) return trimmed;
  return `${trimmed}\n${marker}`;
}

function fixedText(value: string, keep: string[], binding: WorkflowBinding): string {
  const fragments = promptFragments(value);
  const available = new Map(fragments.map(fragment => [fragment.id, fragment.text]));
  const unknown = keep.filter(id => !available.has(id));
  if (unknown.length) {
    throw new Error(`AI 为节点 ${binding.node}.${binding.input} 返回了不存在的片段：${unknown.join('、')}`);
  }
  return fragments
    .filter(fragment => keep.includes(fragment.id))
    .map(fragment => fragment.text)
    .join(', ');
}

function renderTextBinding(value: string, binding: WorkflowBinding): string {
  const base = fixedText(value, binding.keep ?? [], binding);
  if (binding.purpose === 'positive_tag') return appendComma(base, '%prompt%');
  if (binding.purpose === 'positive_nl') return appendLine(base, '%nl%');
  if (binding.purpose === 'positive_combined') {
    return appendLine(appendComma(base, '%prompt%'), '%nl%');
  }
  if (binding.purpose === 'negative') return appendComma(base, '%negative_prompt%');
  return `%${binding.purpose}%`;
}

function editableInput(workflow: ComfyWorkflow, binding: WorkflowBinding): string | number {
  const node = workflow[binding.node];
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`AI 返回的节点 ${binding.node} 不存在`);
  }
  const inputs = node.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error(`节点 ${binding.node} 没有可编辑的 inputs`);
  }
  if (!Object.hasOwn(inputs, binding.input)) {
    throw new Error(`节点 ${binding.node} 不存在输入 ${binding.input}`);
  }
  const value = (inputs as Record<string, unknown>)[binding.input];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`节点 ${binding.node}.${binding.input} 不是可直接替换的文本或数字输入`);
  }
  return value;
}

export function applyWorkflowBindings(template: string, bindings: WorkflowBinding[]): WorkflowAssistResult {
  const workflow = parseWorkflowTemplate(template);
  const changes: WorkflowChange[] = [];
  let hasPositive = false;
  let nlMode: WorkflowAssistResult['nlMode'] = 'none';
  let hasNegative = false;

  for (const binding of bindings) {
    const before = editableInput(workflow, binding);
    // Baibai-nl:positive_nl(独立自然语言正向输入)同样算正向提示词——
    // 自然语言原生工作流(Flux/Qwen-Image 类)可以只有它,没有 tag 输入。
    if (
      binding.purpose === 'positive_tag' ||
      binding.purpose === 'positive_combined' ||
      binding.purpose === 'positive_nl'
    ) {
      hasPositive = true;
    }
    if (binding.purpose === 'positive_nl' && nlMode === 'none') nlMode = 'separate';
    if (binding.purpose === 'positive_combined') nlMode = 'combined';
    if (binding.purpose === 'negative') hasNegative = true;

    const after =
      binding.purpose === 'seed' || binding.purpose === 'width' || binding.purpose === 'height'
        ? `%${binding.purpose}%`
        : renderTextBinding(String(before), binding);
    const inputs = workflow[binding.node].inputs as Record<string, unknown>;
    inputs[binding.input] = after;
    if (String(before) !== after) changes.push({ ...binding, before, after });
  }

  const existing = getWorkflowPlaceholders(template);
  // Baibai-nl:已含 %prompt% 或 %nl% 的工作流都算有正向输入(后者是自然语言原生工作流)。
  if (!hasPositive && !existing.includes('prompt') && !existing.includes('nl')) {
    throw new Error('AI 没有找到正向提示词输入');
  }
  const rendered = JSON.stringify(workflow, null, 2);
  const renderedPlaceholders = getWorkflowPlaceholders(rendered);
  if (!renderedPlaceholders.includes('prompt') && !renderedPlaceholders.includes('nl')) {
    throw new Error('自动配置后的工作流仍缺少 %prompt% 或 %nl%');
  }
  return { workflow: rendered, changes, nlMode, hasNegative };
}

export async function configureWorkflowWithAi(
  template: string,
  signal?: AbortSignal,
): Promise<WorkflowAssistResult> {
  const workflow = parseWorkflowTemplate(template);
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `请定位以下 ComfyUI API 工作流的动态输入。文本值已拆成片段编号：\n${JSON.stringify(workflowAnalysisPayload(workflow))}`,
    },
  ];
  const channel = getTagGenChannel();
  const raw = channel
    ? await requestCompletion(channel, messages, { signal, source: 'ComfyUI 工作流配置' })
    : await requestViaMainApi(messages, { signal, source: 'ComfyUI 工作流配置' });
  return applyWorkflowBindings(template, parseWorkflowBindings(raw));
}
