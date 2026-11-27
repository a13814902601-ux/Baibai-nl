import { ComfyUIError, parseWorkflowTemplate, type ComfyWorkflow } from '@/backends/comfyui';

type LoraClass = 'LoraLoader' | 'LoraLoaderModelOnly';
type Connection = [nodeId: string, output: number];
type Port = 'model' | 'clip';
type Output = Port | 'other';
type Inputs = Record<string, unknown>;
type Node = { class_type: string; inputs: Inputs };

export interface WorkflowLora {
  id: string;
  classType: LoraClass;
  name: string | null;
  strengthModel: number | null;
  strengthClip: number | null;
}

export type WorkflowLoraEdit =
  | { field: 'lora_name'; value: string }
  | { field: 'strength_model' | 'strength_clip'; value: number };

function isObject(value: unknown): value is Inputs {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isLoraClass(value: string): value is LoraClass {
  return value === 'LoraLoader' || value === 'LoraLoaderModelOnly';
}

function parse(template: string) {
  const workflow: ComfyWorkflow = parseWorkflowTemplate(template);
  const nodes = new Map<string, Node>();
  for (const [id, node] of Object.entries(workflow)) {
    if (!isObject(node) || typeof node.class_type !== 'string' || !isObject(node.inputs)) {
      throw new ComfyUIError(`节点 #${id} 缺少 API 格式的节点类型或输入`);
    }
    nodes.set(id, { class_type: node.class_type, inputs: node.inputs });
  }
  return { workflow, nodes };
}

function strength(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readWorkflowLoras(template: string): WorkflowLora[] {
  const { nodes } = parse(template);
  const loras: WorkflowLora[] = [];
  for (const [id, { class_type, inputs }] of nodes) {
    if (!isLoraClass(class_type)) continue;
    loras.push({
      id,
      classType: class_type,
      name: typeof inputs.lora_name === 'string' ? inputs.lora_name : null,
      strengthModel: strength(inputs.strength_model),
      strengthClip: class_type === 'LoraLoader' ? strength(inputs.strength_clip) : null,
    });
  }
  return loras;
}

function loraNode(nodes: Map<string, Node>, id: string): Node {
  const node = nodes.get(id);
  if (!node || !isLoraClass(node.class_type)) throw new ComfyUIError(`找不到原生 LoRA 节点 #${id}`);
  return node;
}

function filename(value: string): string {
  if (!value.trim()) throw new ComfyUIError('请填写 LoRA 文件名');
  return value.trim();
}

export function editWorkflowLora(template: string, id: string, edit: WorkflowLoraEdit): string {
  const { workflow, nodes } = parse(template);
  const node = loraNode(nodes, id);
  if (edit.field === 'strength_clip' && node.class_type !== 'LoraLoader') {
    throw new ComfyUIError('这个 LoRA 节点没有 CLIP 强度');
  }
  const current = node.inputs[edit.field];
  if (typeof current !== typeof edit.value) {
    throw new ComfyUIError('这个参数由连线或其他值提供，请在工作流 JSON 中编辑');
  }
  if (edit.field !== 'lora_name' && (!Number.isFinite(edit.value) || edit.value < -100 || edit.value > 100)) {
    throw new ComfyUIError('LoRA 强度须在 -100 到 100 之间');
  }
  const value = edit.field === 'lora_name' ? filename(edit.value) : edit.value;
  if (value === current) return template;
  node.inputs[edit.field] = value;
  return JSON.stringify(workflow, null, 2);
}

function connection(value: unknown): Connection | null {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string'
    && Number.isSafeInteger(value[1]) && value[1] >= 0
    ? [value[0], value[1]]
    : null;
}

interface Use {
  nodeId: string;
  field: string;
  from: Connection;
}

function connections(nodes: Map<string, Node>): Use[] {
  const links: Use[] = [];
  for (const [nodeId, { inputs }] of nodes) {
    for (const [field, value] of Object.entries(inputs)) {
      const from = connection(value);
      if (from) links.push({ nodeId, field, from });
    }
  }
  return links;
}

function upstream(nodes: Map<string, Node>, id: string, port: Port): Connection {
  const from = connection(nodes.get(id)?.inputs[port]);
  const source = from && nodes.get(from[0]);
  if (!from || !source || from[0] === id) {
    throw new ComfyUIError(`节点 #${id} 的 ${port} 上游连线无效，请先在工作流中修复`);
  }
  const output = knownOutput(source.class_type, from[1]);
  if (output && output !== port) {
    throw new ComfyUIError(`节点 #${id} 的 ${port} 连到了不兼容的输出`);
  }
  return from;
}

function directUses(nodes: Map<string, Node>, id: string, acceptsClip: boolean): Use[] {
  const uses: Use[] = [];
  for (const [nodeId, { inputs }] of nodes) {
    for (const [field, value] of Object.entries(inputs)) {
      if (!Array.isArray(value) || value[0] !== id) continue;
      const from = connection(value);
      if (!from || nodeId === id || (from[1] !== 0 && !(acceptsClip && from[1] === 1))) {
        throw new ComfyUIError(`节点 #${nodeId} 的 ${field} 引用了无法安全重接的 LoRA 输出`);
      }
      uses.push({ nodeId, field, from });
    }
  }
  return uses;
}

function assertNoCycle(nodes: Map<string, Node>, sources: Connection[], consumers: Set<string>) {
  const pending = sources.map(([id]) => id);
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (consumers.has(id)) throw new ComfyUIError('重接会形成循环，工作流未修改');
    if (seen.has(id)) continue;
    seen.add(id);
    for (const value of Object.values(nodes.get(id)?.inputs ?? {})) {
      const from = connection(value);
      if (from) pending.push(from[0]);
    }
  }
}

export function removeWorkflowLora(template: string, id: string): string {
  const { workflow, nodes } = parse(template);
  const node = loraNode(nodes, id);
  const uses = directUses(nodes, id, node.class_type === 'LoraLoader');
  if (nodes.size === 1) throw new ComfyUIError('工作流必须至少保留一个节点');

  for (const slot of new Set(uses.map(use => use.from[1]))) {
    const source = upstream(nodes, id, slot === 0 ? 'model' : 'clip');
    const affected = uses.filter(use => use.from[1] === slot);
    assertNoCycle(nodes, [source], new Set([id, ...affected.map(use => use.nodeId)]));
    for (const use of affected) nodes.get(use.nodeId)!.inputs[use.field] = source;
  }
  delete workflow[id];
  return JSON.stringify(workflow, null, 2);
}

function chainTail(nodes: Map<string, Node>, ids: string[]): string {
  const previous = new Map(ids.map(id => [id, upstream(nodes, id, 'model')[0]]));
  const parents = new Set(previous.values());
  const tails = ids.filter(id => !parents.has(id));
  let position = tails[0];
  const chain: string[] = [];
  while (position && previous.has(position) && chain.length < ids.length) {
    chain.push(position);
    position = previous.get(position)!;
  }
  if (tails.length !== 1 || chain.length !== ids.length || previous.has(position)) {
    throw new ComfyUIError('工作流里有多条 LoRA 链、分叉或循环，无法确定添加位置');
  }

  let previousClip: string | undefined;
  for (const id of chain.reverse()) {
    if (nodes.get(id)?.class_type !== 'LoraLoader') continue;
    const [clip] = upstream(nodes, id, 'clip');
    if (previousClip ? clip !== previousClip : previous.has(clip)) {
      throw new ComfyUIError('LoRA 的模型与 CLIP 连线经过了不同的分支，无法自动添加');
    }
    previousClip = id;
  }
  return tails[0];
}

const checkpointLoaders = new Set(['CheckpointLoaderSimple', 'CheckpointLoader', 'DiffusersLoader']);
const modelLoaders = new Set(['UNETLoader', 'UnetLoaderGGUF', 'LoraLoaderModelOnly']);
const clipLoaders = new Set(['CLIPLoader', 'DualCLIPLoader', 'TripleCLIPLoader', 'QuadrupleCLIPLoader']);
const typedConsumers: Record<Port, Set<string>> = {
  model: new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'BasicGuider', 'CFGGuider', 'DualCFGGuider', 'ModelSamplingAuraFlow']),
  clip: new Set(['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeSDXLRefiner', 'CLIPTextEncodeFlux', 'CLIPSetLastLayer']),
};

function knownOutput(classType: string, slot: number): Output | undefined {
  if (checkpointLoaders.has(classType) || classType === 'LoraLoader') {
    return slot === 0 ? 'model' : slot === 1 ? 'clip' : 'other';
  }
  if (modelLoaders.has(classType)) return slot === 0 ? 'model' : 'other';
  if (clipLoaders.has(classType)) return slot === 0 ? 'clip' : 'other';
  return undefined;
}

function sameConnection(a: Connection, b: Connection) {
  return a[0] === b[0] && a[1] === b[1];
}

function roots(nodes: Map<string, Node>, links: Use[], port: Port) {
  const outputs = new Map<string, { link: Connection; confirmed: boolean }>();
  for (const { nodeId, field, from } of links) {
    const source = nodes.get(from[0]);
    const output = source && knownOutput(source.class_type, from[1]);
    if (field === port && (!source || (output && output !== port))) {
      throw new ComfyUIError(`存在悬空或不兼容的 ${port} 连线，请先在工作流中修复`);
    }
    if (output === port || (source && !output && field === port && !connection(source.inputs[port]))) {
      const key = JSON.stringify(from);
      const confirmed = output === port || typedConsumers[port].has(nodes.get(nodeId)!.class_type);
      outputs.set(key, { link: from, confirmed: confirmed || !!outputs.get(key)?.confirmed });
    }
  }
  return [...outputs.values()];
}

function initialInsertion(nodes: Map<string, Node>) {
  const links = connections(nodes);
  const models = roots(nodes, links, 'model');
  if (models.length !== 1 || !models[0].confirmed) {
    throw new ComfyUIError('找不到唯一的模型连线，请在 ComfyUI 中手动添加 LoRA');
  }
  const { link: model } = models[0];
  const clips = roots(nodes, links, 'clip');
  const pairedClips = clips.filter(({ link }) => link[0] === model[0]);
  const paired = pairedClips[0];
  if (paired && (clips.length > 1 || !paired.confirmed || sameConnection(model, paired.link))) {
    throw new ComfyUIError('模型对应的 CLIP 连线有歧义，请在 ComfyUI 中手动添加 LoRA');
  }
  const clip = paired?.link;
  const uses = links.filter(use => sameConnection(use.from, model) || (clip && sameConnection(use.from, clip)));
  return { model, clip, uses };
}

export function addWorkflowLora(template: string, name: string): string {
  const loraName = filename(name);
  const { workflow, nodes } = parse(template);
  const ids = [...nodes].filter(([, node]) => isLoraClass(node.class_type)).map(([id]) => id);
  const tail = ids.length ? chainTail(nodes, ids) : null;
  const insertion = tail === null
    ? initialInsertion(nodes)
    : {
        model: [tail, 0] as Connection,
        clip: nodes.get(tail)?.class_type === 'LoraLoader' ? [tail, 1] as Connection : undefined,
        uses: directUses(nodes, tail, nodes.get(tail)?.class_type === 'LoraLoader'),
      };
  const { model, clip, uses } = insertion;
  if (!uses.some(use => sameConnection(use.from, model))) {
    throw new ComfyUIError('LoRA 链尾没有接到下游模型节点，请先检查工作流连线');
  }
  assertNoCycle(nodes, clip ? [model, clip] : [model], new Set(uses.map(use => use.nodeId)));
  const occupied = new Set([...nodes.keys(), ...connections(nodes).map(use => use.from[0])]);
  let nextId = 1;
  while (occupied.has(String(nextId))) nextId += 1;
  const id = String(nextId);
  workflow[id] = {
    class_type: clip ? 'LoraLoader' : 'LoraLoaderModelOnly',
    inputs: { model, lora_name: loraName, strength_model: 1, ...(clip && { clip, strength_clip: 1 }) },
  };
  for (const use of uses) {
    nodes.get(use.nodeId)!.inputs[use.field] = [id, sameConnection(use.from, model) ? 0 : 1];
  }
  return JSON.stringify(workflow, null, 2);
}
