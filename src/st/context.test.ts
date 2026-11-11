import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  currentCharacterWorldBookName,
  isAiStoryMessage,
  isStoryMessage,
  type STContext,
  type STMessage,
} from '@/st/context';

function msg(over: Partial<STMessage> = {}): STMessage {
  return { name: 'Char', is_user: false, is_system: false, mes: '她推开门。', ...over };
}

describe('isStoryMessage', () => {
  it('accepts ordinary AI and user floors', () => {
    expect(isStoryMessage(msg())).toBe(true);
    expect(isStoryMessage(msg({ is_user: true, name: 'User' }))).toBe(true);
  });

  it('accepts a floor hidden by /hide — is_system alone is not a system message', () => {
    // ST 的 /hide 只翻 is_system、不碰 extra(chats.js hideChatMessageRange),
    // 语义是「不进提示词」而非「不是剧情」。楼层按钮与自动 tag 都得照跑。
    expect(isStoryMessage(msg({ is_system: true }))).toBe(true);
  });

  it('rejects real ST system messages (they carry a string extra.type)', () => {
    expect(isStoryMessage(msg({ is_system: true, extra: { type: 'narrator' } }))).toBe(false);
    expect(isStoryMessage(msg({ is_system: true, extra: { type: 'comment' } }))).toBe(false);
  });

  it('ignores extra.type on a floor that is not is_system', () => {
    // /role assistant 会 delete extra.type,但历史消息里可能有残留;is_system=false 时不算系统楼
    expect(isStoryMessage(msg({ extra: { type: 'narrator' } }))).toBe(true);
  });

  it('rejects missing, empty and blank text', () => {
    expect(isStoryMessage(undefined)).toBe(false);
    expect(isStoryMessage(msg({ mes: '' }))).toBe(false);
    expect(isStoryMessage(msg({ mes: '  \n ' }))).toBe(false);
    expect(isStoryMessage(msg({ mes: undefined as unknown as string }))).toBe(false);
  });
});

describe('isAiStoryMessage', () => {
  it('is isStoryMessage minus user floors', () => {
    expect(isAiStoryMessage(msg())).toBe(true);
    expect(isAiStoryMessage(msg({ is_system: true }))).toBe(true);
    expect(isAiStoryMessage(msg({ is_user: true }))).toBe(false);
    expect(isAiStoryMessage(msg({ is_system: true, extra: { type: 'narrator' } }))).toBe(false);
    expect(isAiStoryMessage(undefined)).toBe(false);
  });
});

describe('currentCharacterWorldBookName', () => {
  // getContext 走 window.SillyTavern;单测里造一个最小假宿主
  let windowHolder: { window?: unknown } = globalThis as { window?: unknown };

  function fakeContext(over: Partial<STContext> = {}): STContext {
    return {
      chat: [],
      chatMetadata: {},
      name1: 'User',
      name2: 'Char',
      getCurrentChatId: () => 'chat-a',
      getRequestHeaders: () => ({}),
      saveMetadataDebounced: () => undefined,
      saveChat: async () => undefined,
      eventSource: { on: () => undefined },
      eventTypes: {} as STContext['eventTypes'],
      ...over,
    };
  }

  beforeEach(() => {
    windowHolder = globalThis as { window?: unknown };
  });

  afterEach(() => {
    delete windowHolder.window;
  });

  it('reads data.extensions.world of the current single-chat character', () => {
    windowHolder.window = {
      SillyTavern: {
        getContext: () =>
          fakeContext({
            characterId: 1,
            characters: [
              { name: 'A', avatar: 'a.png' },
              { name: 'B', avatar: 'b.png', data: { extensions: { world: ' 设定集 ' } } },
            ],
          }),
      },
    };
    expect(currentCharacterWorldBookName()).toBe('设定集');
  });

  it('returns null for group chat, missing id, or card without a book', () => {
    const withChar = (over: Partial<STContext>) =>
      windowHolder.window = {
        SillyTavern: { getContext: () => fakeContext(over) },
      };

    withChar({ characterId: 0, characters: [{ name: 'A', avatar: 'a.png' }] });
    expect(currentCharacterWorldBookName()).toBeNull();

    withChar({ characterId: '', characters: [{ name: 'A', avatar: 'a.png' }] });
    expect(currentCharacterWorldBookName()).toBeNull();

    withChar({
      characterId: 0,
      groupId: 'g1',
      characters: [{ name: 'A', avatar: 'a.png', data: { extensions: { world: '书' } } }],
    });
    expect(currentCharacterWorldBookName()).toBeNull();

    windowHolder.window = undefined;
    expect(currentCharacterWorldBookName()).toBeNull();
  });
});
