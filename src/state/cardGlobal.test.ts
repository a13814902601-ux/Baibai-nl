import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 角色卡全局设定(state/cardGlobal.ts)集成测试。
 * 以假 window.SillyTavern.getContext 喂一个内存 extensionSettings/角色表,
 * 验证:按卡(avatar)落盘与清除、当前卡识别(单聊/群聊/未打开)、
 * 设定块渲染(跳空字段/全空为空串)、存量领养、字段清洗。
 */

interface FakeCtx {
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  chat: Array<Record<string, unknown>>;
  characters?: Array<{ name: string; avatar: string }>;
  characterId?: string | number;
  groupId?: string;
  saveSettingsDebounced: ReturnType<typeof vi.fn>;
  saveMetadataDebounced: ReturnType<typeof vi.fn>;
  saveChat: ReturnType<typeof vi.fn>;
  eventSource: { on: ReturnType<typeof vi.fn> };
  eventTypes: Record<string, string>;
}

let ctx: FakeCtx;
// 每次 resetModules 后动态重进,保证模块级状态(fingerprint/revision/监听绑定)干净
let cardGlobal: typeof import('@/state/cardGlobal');

function setSingleChat(): void {
  ctx.characters = [
    { name: '小雪', avatar: 'other.png' },
    { name: '苍', avatar: 'cang.png' },
  ];
  ctx.characterId = 1;
  ctx.groupId = undefined;
}

beforeEach(async () => {
  vi.resetModules();
  ctx = {
    extensionSettings: {},
    chatMetadata: {},
    chat: [],
    saveSettingsDebounced: vi.fn(),
    saveMetadataDebounced: vi.fn(),
    saveChat: vi.fn(() => Promise.resolve()),
    eventSource: { on: vi.fn() },
    eventTypes: { CHAT_CHANGED: 'chat_changed' },
  };
  (globalThis as Record<string, unknown>).window = {
    SillyTavern: { getContext: () => ctx },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  cardGlobal = await import('@/state/cardGlobal');
  cardGlobal.initCardGlobal();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

describe('card global store', () => {
  it('saveCardGlobal 按 avatar 落盘 extensionSettings 并更新响应式库', () => {
    const ok = cardGlobal.saveCardGlobal('cang.png', {
      style: '厚涂赛璐璐',
      globalTendency: '',
      characterTendency: '优先半身特写',
    });
    expect(ok).toBe(true);
    expect(cardGlobal.cardGlobalStore.cards['cang.png']).toEqual({
      style: '厚涂赛璐璐',
      globalTendency: '',
      characterTendency: '优先半身特写',
    });
    const stored = ctx.extensionSettings['baibai_image_card_global'] as {
      schemaVersion: number;
      revision: number;
      cards: Record<string, { style: string }>;
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.revision).toBe(1);
    expect(stored.cards['cang.png'].style).toBe('厚涂赛璐璐');
    expect(ctx.saveSettingsDebounced).toHaveBeenCalled();
  });

  it('全字段为空的保存视为清除;未存在时全空保存不落盘', () => {
    cardGlobal.saveCardGlobal('cang.png', {
      style: '水彩',
      globalTendency: '柔和光线',
      characterTendency: '',
    });
    // 清除
    expect(cardGlobal.saveCardGlobal('cang.png', cardGlobal.emptyCardGlobalPreset())).toBe(true);
    expect(cardGlobal.cardGlobalStore.cards).toEqual({});
    // 再对不存在的卡全空保存:无事发生(首次写入 + 清除各落盘一次)
    expect(cardGlobal.saveCardGlobal('cang.png', cardGlobal.emptyCardGlobalPreset())).toBe(false);
    expect(ctx.saveSettingsDebounced).toHaveBeenCalledTimes(2);
  });

  it('字段清洗:换行压成空格、bbi_image 系子标签字面量整值丢弃', () => {
    cardGlobal.saveCardGlobal('cang.png', {
      style: '水彩,\n淡彩',
      globalTendency: '<bbi_image>画风</bbi_image>',
      characterTendency: '  ',
    });
    expect(cardGlobal.cardGlobalStore.cards['cang.png']).toEqual({
      style: '水彩, 淡彩',
      globalTendency: '',
      characterTendency: '',
    });
    // 带子标签字面量的值被整值丢弃后,设定块里不会再出现标签
    expect(cardGlobal.cardGlobalPromptText(cardGlobal.cardGlobalStore.cards['cang.png'])).not.toContain('bbi_image');
  });

  it('initCardGlobal 领养 extensionSettings 里的存量数据', async () => {
    ctx.extensionSettings['baibai_image_card_global'] = {
      schemaVersion: 1,
      revision: 7,
      cards: { 'old.png': { style: '水墨', globalTendency: '', characterTendency: '突出表情' } },
    };
    // 重新 init(模拟另一实例启动领养)
    vi.resetModules();
    cardGlobal = await import('@/state/cardGlobal');
    cardGlobal.initCardGlobal();
    expect(cardGlobal.cardGlobalStore.cards['old.png']).toEqual({
      style: '水墨',
      globalTendency: '',
      characterTendency: '突出表情',
    });
  });
});

describe('current card identity', () => {
  it('单聊取 characters[characterId].avatar;群聊与未打开为 null', () => {
    setSingleChat();
    expect(cardGlobal.currentCardAvatar()).toBe('cang.png');
    expect(cardGlobal.currentCardLabel.value === null || cardGlobal.currentCardLabel.value === '苍').toBe(true);

    ctx.groupId = 'g1';
    expect(cardGlobal.currentCardAvatar()).toBeNull();

    ctx.groupId = undefined;
    ctx.characterId = '';
    expect(cardGlobal.currentCardAvatar()).toBeNull();
  });

  it('refreshCurrentCard 随 CHAT_CHANGED 绑定,并刷新 label', () => {
    setSingleChat();
    cardGlobal.refreshCurrentCard();
    expect(cardGlobal.currentCardKey.value).toBe('cang.png');
    expect(cardGlobal.currentCardLabel.value).toBe('苍');
    // init 时绑定了 CHAT_CHANGED → refreshCurrentCard
    const calls = (ctx.eventSource.on as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'chat_changed',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('prompt text', () => {
  it('cardGlobalPromptText 只渲染非空字段,全空返回空串', () => {
    expect(cardGlobal.cardGlobalPromptText(cardGlobal.emptyCardGlobalPreset())).toBe('');
    const text = cardGlobal.cardGlobalPromptText({
      style: '厚涂赛璐璐',
      globalTendency: '',
      characterTendency: '优先半身特写',
    });
    expect(text).toContain('【角色卡全局设定】');
    expect(text).toContain('画风=厚涂赛璐璐');
    expect(text).toContain('角色生成倾向=优先半身特写');
    expect(text).not.toContain('全局生成倾向=');
    expect(text).toContain('执行要求');
  });

  it('resolveCardGlobalText:当前卡有设定则产出设定块,群聊/无卡/未配置为空串', () => {
    setSingleChat();
    expect(cardGlobal.resolveCardGlobalText()).toBe('');
    cardGlobal.saveCardGlobal('cang.png', {
      style: '厚涂',
      globalTendency: '',
      characterTendency: '',
    });
    expect(cardGlobal.resolveCardGlobalText()).toContain('画风=厚涂');

    ctx.groupId = 'g1';
    expect(cardGlobal.resolveCardGlobalText()).toBe('');
  });
});
