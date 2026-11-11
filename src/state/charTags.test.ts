import { describe, expect, it } from 'vitest';

import {
  BBI_CHAR_EXTRA_KEY,
  applyCharTagOps,
  computeLockedCharTagNames,
  createCharTagNewOp,
  createCharTagSetOp,
  deriveCharTags,
  emptyCharFields,
  mergeCharTagSeed,
  normalizeCharTagStore,
  type CharTagAutoOp,
} from '@/state/charTags';
import type { STMessage } from '@/st/context';

function floorMessage(ops: CharTagAutoOp[], swipe = 0, storedSwipe = swipe): STMessage {
  return {
    name: 'Char',
    is_user: false,
    is_system: false,
    mes: '正文',
    swipes: ['正文', '另一页'],
    swipe_id: swipe,
    extra: {
      [BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: storedSwipe, ops },
    },
  };
}

describe('char tags store normalize', () => {
  it('keeps valid structured entries and normalizes fields', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        {
          name: '阿黛尔',
          fields: { sex: '1girl', hair: ' short silver hair ' },
          source: 'book',
          desc: '银色短发',
        },
        { name: ' 铁匠老周 ', fields: { sex: '1boy' }, source: 'manual' },
      ],
    });
    expect(entries).toEqual([
      {
        name: '阿黛尔',
        fields: {
          ...emptyCharFields(),
          sex: '1girl',
          hair: 'short silver hair',
        },
        raw: '',
        nl: '',
        source: 'book',
        desc: '银色短发',
        history: [],
      },
      {
        name: '铁匠老周',
        fields: { ...emptyCharFields(), sex: '1boy' },
        raw: '',
        nl: '',
        source: 'manual',
        desc: '',
        history: [],
      },
    ]);
  });

  it('migrates v1 legacy tags string into raw mode', () => {
    const entries = normalizeCharTagStore({
      version: 1,
      entries: [{ name: '旧角色', tags: '1girl, red eyes', source: 'book', desc: '红瞳' }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].raw).toBe('1girl, red eyes');
    expect(entries[0].fields).toEqual(emptyCharFields());
    expect(entries[0].source).toBe('book');
    expect(entries[0].desc).toBe('红瞳');
  });

  it('drops entries without any usable content', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        { name: '', fields: { sex: '1girl' } },
        { name: '空的', fields: {} },
        { name: '空白', fields: { hair: '   ' }, raw: ' ' },
        'not-an-object',
      ],
    });
    expect(entries).toEqual([]);
  });

  it('unknown source falls back to manual; history records are sanitized', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        {
          name: '路人',
          fields: { sex: '1girl' },
          source: 'weird',
          history: [
            { field: 'hair', from: 'long', to: 'short', reason: '剪发', floor: 42, at: 1 },
            { field: 'bogus', from: 'x', to: 'y' },
            'junk',
          ],
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('manual');
    expect(entries[0].history).toEqual([
      { field: 'hair', from: 'long', to: 'short', reason: '剪发', floor: 42, at: 1 },
    ]);
  });

  it('dedupes by name, keeping the first occurrence', () => {
    const entries = normalizeCharTagStore({
      version: 2,
      entries: [
        { name: '阿黛尔', fields: { sex: 'a' }, source: 'book', desc: 'd1' },
        { name: '阿黛尔', fields: { sex: 'b' }, source: 'manual' },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].fields.sex).toBe('a');
  });

  it('returns empty for malformed stores', () => {
    expect(normalizeCharTagStore(null)).toEqual([]);
    expect(normalizeCharTagStore({ version: 2 })).toEqual([]);
    expect(normalizeCharTagStore('junk')).toEqual([]);
  });
});

describe('floor-owned character changes', () => {
  it('removes a character when its creation floor is deleted', () => {
    const create = createCharTagNewOp({
      name: '小雪',
      fields: { ...emptyCharFields(), sex: '1girl', hair: 'long black hair' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    const cutHair = createCharTagSetOp('小雪', 'hair', 'short black hair', '剪发')!;
    const chat = [floorMessage([create]), floorMessage([cutHair])];

    expect(deriveCharTags([], chat)[0].fields.hair).toBe('short black hair');
    chat.splice(0, 1);
    expect(deriveCharTags([], chat)).toEqual([]);
  });

  it('reverts a field when only the later change floor is deleted', () => {
    const create = createCharTagNewOp({
      name: '小雪',
      fields: { ...emptyCharFields(), hair: 'long black hair' },
      raw: '',
      nl: '',
      source: 'book',
      desc: '黑色长发',
    })!;
    const cutHair = createCharTagSetOp('小雪', 'hair', 'short black hair', '剪发')!;
    const chat = [floorMessage([create]), floorMessage([cutHair])];

    chat.pop();
    const [entry] = deriveCharTags([], chat);
    expect(entry.fields.hair).toBe('long black hair');
    expect(entry.history).toHaveLength(1);
    expect(entry.history[0].floor).toBe(0);
  });

  it('ignores changes copied from another swipe', () => {
    const create = createCharTagNewOp({
      name: '旧页角色',
      fields: { ...emptyCharFields(), sex: '1girl' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    expect(deriveCharTags([], [floorMessage([create], 1, 0)])).toEqual([]);
  });
});

describe('global library merge & lock', () => {
  const globalEntry = (name: string, fields: Record<string, string>) => ({
    name,
    fields: { ...emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source: 'manual' as const,
    desc: '',
    history: [],
  });

  it('mergeCharTagSeed: 本聊天同名条目优先,全局只补同名空缺', () => {
    const chat = [globalEntry('小雪', { hair: 'short red hair' })];
    const global = [globalEntry('小雪', { hair: 'long black hair' }), globalEntry('玩家', { sex: '1boy' })];
    const merged = mergeCharTagSeed(chat, global);
    expect(merged).toHaveLength(2);
    expect(merged.find(e => e.name === '小雪')?.fields.hair).toBe('short red hair');
    expect(merged.find(e => e.name === '玩家')?.fields.sex).toBe('1boy');
    // 无全局时原样返回(零开销路径)
    expect(mergeCharTagSeed(chat, [])).toBe(chat);
  });

  it('computeLockedCharTagNames: 只有「全局独有」的名字被锁定;本聊天同名即解锁', () => {
    const global = [globalEntry('玩家', { sex: '1boy' }), globalEntry('小雪', { sex: '1girl' })];
    expect([...computeLockedCharTagNames([], global)].sort()).toEqual(['小雪', '玩家']);
    expect([...computeLockedCharTagNames([globalEntry('小雪', { sex: '1girl' })], global)]).toEqual(['玩家']);
    expect(computeLockedCharTagNames([], []).size).toBe(0);
  });

  it('applyCharTagOps: 锁定名的 new 与 set 一律丢弃', () => {
    const locked = new Set(['玩家']);
    const create = createCharTagNewOp({
      name: '玩家',
      fields: { ...emptyCharFields(), sex: '1boy', hair: 'short black hair' },
      raw: '',
      nl: '',
      source: 'ai',
      desc: '',
    })!;
    const dye = createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    const base = [globalEntry('玩家', { sex: '1boy', hair: 'short black hair' })];
    const out = applyCharTagOps(base, [create, dye], 3, locked);
    expect(out[0].fields.hair).toBe('short black hair');
    expect(out[0].history).toEqual([]);
    // 不传 locked 时旧行为不变
    const out2 = applyCharTagOps(base, [dye], 3);
    expect(out2[0].fields.hair).toBe('long red hair');
  });

  it('deriveCharTags: 旧消息里针对锁定角色的楼层 ops 重放时失效', () => {
    const dye = createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    const chat = [floorMessage([dye])];
    const base = [globalEntry('玩家', { sex: '1boy', hair: 'short black hair' })];
    expect(deriveCharTags(base, chat, chat.length, new Set(['玩家']))[0].fields.hair).toBe('short black hair');
    expect(deriveCharTags(base, chat)[0].fields.hair).toBe('long red hair');
  });
});
