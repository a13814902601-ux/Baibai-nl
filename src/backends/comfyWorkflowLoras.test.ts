import { describe, expect, it } from 'vitest';
import {
  addWorkflowLora,
  editWorkflowLora,
  readWorkflowLoras,
  removeWorkflowLora,
} from '@/backends/comfyWorkflowLoras';

function checkpointWorkflow() {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: '%nl%' } },
    '4': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['3', 0], seed: '%seed%' } },
    '5': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: '%negative_prompt%' } },
  };
}

describe('自定义工作流 LoRA 编辑', () => {
  it('识别两个原生类型，逐字段编辑并保留其他数据和连线', () => {
    const workflow = {
      ...checkpointWorkflow(),
      '7': {
        class_type: 'LoraLoader',
        inputs: { model: ['1', 0], clip: ['1', 1], lora_name: 'a.safetensors', strength_model: 0.7, strength_clip: -0.2 },
        _meta: { title: '自定义标题', data: ['1', 0] },
      },
      '8': {
        class_type: 'LoraLoaderModelOnly',
        inputs: { model: ['7', 0], lora_name: 'b.safetensors', strength_model: ['10', 0] },
      },
      '9': { class_type: 'ThirdPartyLora', inputs: { lora_name: 'c.safetensors' } },
      '10': { class_type: 'Float', inputs: { value: 0.5 } },
    };
    const template = JSON.stringify(workflow);
    expect(readWorkflowLoras(template)).toEqual([
      { id: '7', classType: 'LoraLoader', name: 'a.safetensors', strengthModel: 0.7, strengthClip: -0.2 },
      { id: '8', classType: 'LoraLoaderModelOnly', name: 'b.safetensors', strengthModel: null, strengthClip: null },
    ]);
    const renamed = editWorkflowLora(template, '7', { field: 'lora_name', value: 'folder/d.safetensors' });
    const adjusted = editWorkflowLora(renamed, '7', { field: 'strength_clip', value: 0 });
    expect(JSON.parse(adjusted)).toEqual({
      ...workflow,
      '7': { ...workflow['7'], inputs: { ...workflow['7'].inputs, lora_name: 'folder/d.safetensors', strength_clip: 0 } },
    });
    expect(() => editWorkflowLora(template, '8', { field: 'strength_model', value: 1 })).toThrow('连线');
    expect(() => editWorkflowLora(template, '8', { field: 'strength_clip', value: 1 })).toThrow('没有 CLIP 强度');
    expect(() => editWorkflowLora(template, '7', { field: 'strength_model', value: Infinity })).toThrow('强度');
  });

  it('给唯一共用加载器插入双路 LoRA，并把所有使用方按输出槽位重接', () => {
    const original = checkpointWorkflow();
    const template = JSON.stringify(original);
    const inserted = addWorkflowLora(template, 'favorite.safetensors');
    const result = JSON.parse(inserted);
    expect(result['2']).toEqual({
      class_type: 'LoraLoader',
      inputs: { model: ['1', 0], clip: ['1', 1], lora_name: 'favorite.safetensors', strength_model: 1, strength_clip: 1 },
    });
    expect(result['3'].inputs).toEqual({ clip: ['2', 1], text: '%nl%' });
    expect(result['4'].inputs).toEqual({ model: ['2', 0], positive: ['3', 0], seed: '%seed%' });
    expect(result['5']).toEqual(original['5']);
    expect(result['6'].inputs.clip).toEqual(['2', 1]);
    expect(JSON.parse(removeWorkflowLora(inserted, '2'))).toEqual(original);
  });

  it('在唯一的扩散模型加载器后加入 ModelOnly，保留模型包装节点和独立 CLIP', () => {
    const original = {
      model: { class_type: 'UNETLoader', inputs: { unet_name: 'base.safetensors' } },
      sampling: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['model', 0], shift: 3 } },
      clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors' } },
      encode: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: '%nl%' } },
      sample: { class_type: 'KSampler', inputs: { model: ['sampling', 0], positive: ['encode', 0] } },
    };
    const result = JSON.parse(addWorkflowLora(JSON.stringify(original), 'style.safetensors'));
    expect(result['1']).toEqual({
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['model', 0], lora_name: 'style.safetensors', strength_model: 1 },
    });
    expect(result.sampling.inputs.model).toEqual(['1', 0]);
    expect(result.encode).toEqual(original.encode);
    expect(result.sample).toEqual(original.sample);
  });

  it('延长现有链，删除链中节点后准确还原两条连线', () => {
    const original = JSON.stringify(checkpointWorkflow());
    const first = addWorkflowLora(original, 'first.safetensors');
    const second = addWorkflowLora(first, 'second.safetensors');
    const result = JSON.parse(second);
    expect(result['7'].inputs).toMatchObject({ model: ['2', 0], clip: ['2', 1] });
    expect(result['3'].inputs.clip).toEqual(['7', 1]);
    expect(result['4'].inputs.model).toEqual(['7', 0]);
    expect(JSON.parse(removeWorkflowLora(second, '2'))['7'].inputs)
      .toMatchObject({ model: ['1', 0], clip: ['1', 1] });
    expect(JSON.parse(removeWorkflowLora(second, '7'))).toEqual(JSON.parse(first));
  });

  it('混用两类节点时延长模型链，CLIP 保留在最后一个双路节点', () => {
    const data = JSON.parse(addWorkflowLora(JSON.stringify(checkpointWorkflow()), 'first.safetensors'));
    data['7'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['2', 0], lora_name: 'second.safetensors', strength_model: 0.8 },
    };
    data['4'].inputs.model = ['7', 0];
    const result = JSON.parse(addWorkflowLora(JSON.stringify(data), 'third.safetensors'));
    expect(result['8']).toMatchObject({ class_type: 'LoraLoaderModelOnly', inputs: { model: ['7', 0] } });
    expect(result['3'].inputs.clip).toEqual(['2', 1]);
    expect(result['4'].inputs.model).toEqual(['8', 0]);
  });

  it('无法确认唯一来源或已存在多个 LoRA 分叉时拒绝添加', () => {
    const source = checkpointWorkflow();
    expect(() => addWorkflowLora(JSON.stringify({
      ...source,
      second: { class_type: 'UNETLoader', inputs: { unet_name: 'other.safetensors' } },
      branch: { class_type: 'KSampler', inputs: { model: ['second', 0] } },
    }), 'new.safetensors')).toThrow('唯一的模型连线');
    const first = addWorkflowLora(JSON.stringify(source), 'first.safetensors');
    const data = JSON.parse(first);
    for (const id of ['7', '8']) {
      data[id] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { lora_name: `${id}.safetensors`, model: ['2', 0], strength_model: 1 },
      };
    }
    expect(() => addWorkflowLora(JSON.stringify(data), 'new.safetensors')).toThrow('分叉');
  });

  it('不把错误的原生输出当成模型，也不把旧悬空连线连到新节点', () => {
    const data = checkpointWorkflow();
    data['4'].inputs.model = ['1', 2];
    expect(() => addWorkflowLora(JSON.stringify(data), 'new.safetensors')).toThrow('不兼容的 model');
    data['4'].inputs.model = ['1', 0];
    data['5'].inputs.samples = ['2', 0];
    const result = JSON.parse(addWorkflowLora(JSON.stringify(data), 'new.safetensors'));
    expect(result['2']).toBeUndefined();
    expect(result['5'].inputs.samples).toEqual(['2', 0]);
    expect(result['7'].class_type).toBe('LoraLoader');
  });

  it('自定义输出必须由已知的类型输入印证，字段名相同不足以自动重连', () => {
    const custom = {
      source: { class_type: 'OtherLoader', inputs: { file: 'base' } },
      sample: { class_type: 'OtherSampler', inputs: { model: ['source', 0] } },
    };
    expect(() => addWorkflowLora(JSON.stringify(custom), 'new.safetensors')).toThrow('找不到唯一的模型连线');
    custom.sample.class_type = 'KSampler';
    const result = JSON.parse(addWorkflowLora(JSON.stringify(custom), 'new.safetensors'));
    expect(result['1'].class_type).toBe('LoraLoaderModelOnly');
    expect(result.sample.inputs.model).toEqual(['1', 0]);
  });

  it('无效 JSON、坏输出、悬空上游或将出现循环时拒绝写回', () => {
    expect(() => readWorkflowLoras('{ "1": ')).toThrow('JSON 格式错误');
    expect(() => addWorkflowLora('{ "1": ', 'new.safetensors')).toThrow('JSON 格式错误');
    const first = addWorkflowLora(JSON.stringify(checkpointWorkflow()), 'first.safetensors');
    const data = JSON.parse(first);
    data['4'].inputs.model = ['2', 3];
    expect(() => removeWorkflowLora(JSON.stringify(data), '2')).toThrow('无法安全重接');
    data['4'].inputs.model = ['2', 0];
    data['2'].inputs.model = ['missing', 0];
    expect(() => removeWorkflowLora(JSON.stringify(data), '2')).toThrow('上游连线无效');
    data['2'].inputs.model = ['4', 0];
    expect(() => removeWorkflowLora(JSON.stringify(data), '2')).toThrow('循环');
  });
});
