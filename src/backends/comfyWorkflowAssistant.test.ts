import { describe, expect, it } from 'vitest';

import {
  applyWorkflowBindings,
  parseWorkflowBindings,
} from '@/backends/comfyWorkflowAssistant';

const WORKFLOW = JSON.stringify({
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 123,
      positive: ['6', 0],
      negative: ['7', 0],
    },
  },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 832, height: 1216 },
  },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'masterpiece, best quality' },
  },
  '7': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'worst quality, bad hands' },
  },
});

describe('parseWorkflowBindings', () => {
  it('reads a fenced response and merges tag/nl on the same input into combined mode', () => {
    const raw = `说明
\`\`\`json
{"bindings":[
  {"node":"6","input":"text","purpose":"positive_tag","keep":["F1"]},
  {"node":"6","input":"text","purpose":"positive_nl","keep":["F2"]}
]}
\`\`\``;
    expect(parseWorkflowBindings(raw)).toEqual([
      { node: '6', input: 'text', purpose: 'positive_combined', keep: ['F1', 'F2'] },
    ]);
  });

  it('rejects conflicting purposes on the same input', () => {
    expect(() =>
      parseWorkflowBindings(
        '{"bindings":[{"node":"6","input":"text","purpose":"positive_tag"},{"node":"6","input":"text","purpose":"negative"}]}',
      ),
    ).toThrow('互相冲突');
  });
});

describe('applyWorkflowBindings', () => {
  it('preserves fixed prompt text and appends local macros', () => {
    const result = applyWorkflowBindings(WORKFLOW, [
      { node: '6', input: 'text', purpose: 'positive_combined', keep: ['F1', 'F2'] },
      { node: '7', input: 'text', purpose: 'negative', keep: ['F1', 'F2'] },
      { node: '3', input: 'seed', purpose: 'seed' },
      { node: '5', input: 'width', purpose: 'width' },
      { node: '5', input: 'height', purpose: 'height' },
    ]);
    const workflow = JSON.parse(result.workflow);

    expect(workflow['6'].inputs.text).toBe('masterpiece, best quality, %prompt%\n%nl%');
    expect(workflow['7'].inputs.text).toBe('worst quality, bad hands, %negative_prompt%');
    expect(workflow['3'].inputs.seed).toBe('%seed%');
    expect(workflow['5'].inputs.width).toBe('%width%');
    expect(workflow['5'].inputs.height).toBe('%height%');
    expect(result.nlMode).toBe('combined');
    expect(result.hasNegative).toBe(true);
  });

  it('does not duplicate placeholders in an already configured text input', () => {
    const configured = JSON.stringify({
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'quality, %prompt%\n%nl%' },
      },
    });
    const result = applyWorkflowBindings(configured, [
      { node: '6', input: 'text', purpose: 'positive_combined', keep: ['F1'] },
    ]);

    expect(result.changes).toEqual([]);
    expect(JSON.parse(result.workflow)['6'].inputs.text).toBe('quality, %prompt%\n%nl%');
  });

  it('rejects linked inputs instead of overwriting graph connections', () => {
    expect(() =>
      applyWorkflowBindings(WORKFLOW, [
        { node: '3', input: 'positive', purpose: 'positive_tag' },
      ]),
    ).toThrow('不是可直接替换');
  });

  it('requires a positive prompt binding when the workflow has no existing %prompt%', () => {
    expect(() =>
      applyWorkflowBindings(WORKFLOW, [
        { node: '7', input: 'text', purpose: 'negative' },
      ]),
    ).toThrow('没有找到正向提示词');
  });

  // Baibai-nl:positive_nl 单独即可满足正向输入,配置出的工作流允许只有 %nl%
  it('accepts a positive_nl-only binding and produces an nl-only workflow', () => {
    const result = applyWorkflowBindings(WORKFLOW, [
      { node: '6', input: 'text', purpose: 'positive_nl', keep: ['F1', 'F2'] },
      { node: '7', input: 'text', purpose: 'negative', keep: ['F1', 'F2'] },
    ]);
    const workflow = JSON.parse(result.workflow);
    expect(workflow['6'].inputs.text).toBe('masterpiece, best quality\n%nl%');
    expect(result.nlMode).toBe('separate');
    expect(result.hasNegative).toBe(true);
  });

  it('keeps only selected fixed fragments and removes exported sample scene content', () => {
    const sample = JSON.stringify({
      '11': {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'masterpiece, best quality, @style, 2girls, cherry blossom tree, cheek to cheek, two girls smiling under pink petals',
        },
      },
      '12': {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'worst quality, bad hands, mature female, short hair',
        },
      },
    });
    const result = applyWorkflowBindings(sample, [
      {
        node: '11',
        input: 'text',
        purpose: 'positive_combined',
        keep: ['F1', 'F2', 'F3'],
      },
      {
        node: '12',
        input: 'text',
        purpose: 'negative',
        keep: ['F1', 'F2'],
      },
    ]);
    const workflow = JSON.parse(result.workflow);

    expect(workflow['11'].inputs.text).toBe('masterpiece, best quality, @style, %prompt%\n%nl%');
    expect(workflow['11'].inputs.text).not.toContain('2girls');
    expect(workflow['11'].inputs.text).not.toContain('cherry blossom');
    expect(workflow['12'].inputs.text).toBe('worst quality, bad hands, %negative_prompt%');
    expect(workflow['12'].inputs.text).not.toContain('mature female');
  });

  it('rejects fragment IDs that do not exist in the original input', () => {
    expect(() =>
      applyWorkflowBindings(WORKFLOW, [
        { node: '6', input: 'text', purpose: 'positive_tag', keep: ['F99'] },
      ]),
    ).toThrow('不存在的片段');
  });
});
