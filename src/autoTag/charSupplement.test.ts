import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestViaMainApi, type ChatMsg } from '@/api/client';

/**
 * 按用户描述补充字段(autoTag/charAnchors.ts supplementCharTags)单测。
 * mock 掉 API 客户端与渠道选择:指派渠道为空 → 走主 API 一次性补全。
 * 验证:请求消息形态(当前档案+用户描述)、宽容解析(think/代码块/杂质)、
 * 空值与脏值剔除、解析失败抛错。
 */

vi.mock('@/api/client', () => ({
  requestCompletion: vi.fn(),
  requestViaMainApi: vi.fn(),
}));
vi.mock('@/state/settings', () => ({
  getTagGenChannel: vi.fn(() => null),
}));

import { parseSupplementFields, supplementCharTags } from '@/autoTag/charAnchors';
import { emptyCharFields } from '@/state/charTags';

beforeEach(() => {
  vi.mocked(requestViaMainApi).mockReset();
});

describe('parseSupplementFields', () => {
  it('parses a flat field object and drops empty/sanitized values', () => {
    const raw = '{"fandom":"","sex":"少女","hair":"银色长发","eyes":"红色的眼睛","skin":"","body":"","extra":"","outfit":"黑色哥特裙"}';
    expect(parseSupplementFields(raw)).toEqual({
      sex: '少女',
      hair: '银色长发',
      eyes: '红色的眼睛',
      outfit: '黑色哥特裙',
    });
  });

  it('tolerates think blocks, code fences and surrounding noise', () => {
    const raw = '<thinking>分析一下</thinking>\n```json\n{"sex":"少年","hair":"乌黑的短发"}\n```\n以上。';
    expect(parseSupplementFields(raw)).toEqual({ sex: '少年', hair: '乌黑的短发' });
  });

  it('strips bbi_image-ish tag literals from values', () => {
    const raw = '{"hair":"<tag>银发</tag>","eyes":"蓝色的眼睛"}';
    expect(parseSupplementFields(raw)).toEqual({ eyes: '蓝色的眼睛' });
  });

  it('returns {} for a valid object with no usable fields, null for garbage', () => {
    expect(parseSupplementFields('{"sex":"","hair":""}')).toEqual({});
    expect(parseSupplementFields('模型拒绝回答')).toBeNull();
  });
});

describe('supplementCharTags', () => {
  it('sends current fields + user request via main api and returns parsed fields', async () => {
    vi.mocked(requestViaMainApi).mockResolvedValue(
      '{"fandom":"《原神》的甘雨","sex":"少女","hair":"银色长发","eyes":"红色的眼睛","skin":"","body":"娇小","extra":"","outfit":"黑色哥特裙"}',
    );
    const fields = { ...emptyCharFields(), sex: '少女', hair: '银色的长发' };
    const result = await supplementCharTags('甘雨', '她是《原神》的甘雨,银发红瞳,娇小,总是穿黑色哥特裙', fields);

    expect(result).toEqual({
      fandom: '《原神》的甘雨',
      sex: '少女',
      hair: '银色长发',
      eyes: '红色的眼睛',
      body: '娇小',
      outfit: '黑色哥特裙',
    });
    const [messages, options] = vi.mocked(requestViaMainApi).mock.calls[0] as [
      ChatMsg[],
      { source: string },
    ];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('外貌档案补充器');
    expect(messages[0].content).toContain('描述与当前值冲突时以描述为准');
    expect(messages[1].content).toContain('角色名：甘雨');
    expect(messages[1].content).toContain('当前档案：');
    expect(messages[1].content).toContain('- 头发：银色的长发');
    expect(messages[1].content).toContain('- 同人身份：（空）');
    expect(messages[1].content).toContain('用户描述：');
    expect(messages[1].content).toContain('总是穿黑色哥特裙');
    expect(options.source).toBe('角色外貌补充');
  });

  it('throws a readable error when the model output is unparseable', async () => {
    vi.mocked(requestViaMainApi).mockResolvedValue('(空)');
    await expect(
      supplementCharTags('小雪', '描述', emptyCharFields()),
    ).rejects.toThrow('模型没有返回可解析的字段结果');
  });
});
