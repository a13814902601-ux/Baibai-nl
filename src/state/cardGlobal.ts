import { getContext } from '@/st/context';
import { reactive, ref } from 'vue';

/**
 * 角色卡全局设定 —— 按角色卡(avatar 为键)存画风与生成倾向,该卡的所有聊天共用。
 *
 * 定位:用户对「这张卡该画成什么样」的手动约束,与外貌库(管角色长什么样)互补:
 * - 画风:写进每张图提示词的整体风格(如「厚涂赛璐璐、色彩浓郁」)。
 * - 全局生成倾向:作用于选图、构图、氛围与光线(如「偏爱柔和光线」)。
 * - 角色生成倾向:作用于角色入镜时的取景与描写侧重(如「优先半身特写」)。
 *
 * 存储:extensionSettings[CARD_GLOBAL_KEY](→ 服务器 settings.json,跨设备同步),
 * 带 revision + 广播事件,协议与 globalCharTags 同构。键是角色卡 avatar 文件名
 * (稳定唯一;name 可能重名)。群聊没有单一角色卡,不适用本设定。
 *
 * 自动 tag 主流程在发请求前经 resolveCardGlobalText() 取当前卡的设定块,
 * 由 prompt.ts 拼进 user 消息;换卡/换聊天即时生效,无需额外同步。
 */

const CARD_GLOBAL_KEY = 'baibai_image_card_global';
const CARD_GLOBAL_EVENT = 'st-baibai-image:card-global-changed';
const SCHEMA_VERSION = 1;

export interface CardGlobalPreset {
  /** 画风:整体画面风格 */
  style: string;
  /** 全局生成倾向:选图/构图/氛围层面的偏好 */
  globalTendency: string;
  /** 角色生成倾向:角色入镜时的取景与描写侧重 */
  characterTendency: string;
}

export type CardGlobalField = keyof CardGlobalPreset;

export const CARD_GLOBAL_FIELDS: readonly CardGlobalField[] = [
  'style',
  'globalTendency',
  'characterTendency',
];

export const CARD_GLOBAL_FIELD_LABELS: Record<CardGlobalField, string> = {
  style: '画风',
  globalTendency: '全局生成倾向',
  characterTendency: '角色生成倾向',
};

interface CardGlobalStore {
  schemaVersion: number;
  revision: number;
  cards: Record<string, CardGlobalPreset>;
}

export const cardGlobalStore = reactive<{ cards: Record<string, CardGlobalPreset> }>({
  cards: {},
});

/** 当前角色卡键(avatar);UI 靠它响应换卡。群聊/未打开聊天为 null。 */
export const currentCardKey = ref<string | null>(null);
/** 当前角色卡显示名(仅 UI 徽标用);与 currentCardKey 同时刷新。 */
export const currentCardLabel = ref<string | null>(null);

let fingerprint = '';
let revision = 0;
let listenerBound = false;
let cardListenerBound = false;

function fingerprintOf(cards: Record<string, CardGlobalPreset>): string {
  return JSON.stringify(cards);
}

export function emptyCardGlobalPreset(): CardGlobalPreset {
  return { style: '', globalTendency: '', characterTendency: '' };
}

export function cardGlobalEmpty(preset: CardGlobalPreset): boolean {
  return CARD_GLOBAL_FIELDS.every(field => !(preset[field] ?? '').trim());
}

/** 与 charAnchors.sanitizeTagValue 同口径:换行压成空格、剥 bbi_image 系子标签字面量。 */
function sanitizeCardGlobalValue(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (!text) return '';
  if (/<\/?(?:bbi_image|tag|nl|size)\b/i.test(text)) return '';
  return text;
}

function normalizePreset(raw: unknown): CardGlobalPreset {
  const preset = emptyCardGlobalPreset();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return preset;
  for (const field of CARD_GLOBAL_FIELDS) {
    preset[field] = sanitizeCardGlobalValue((raw as Record<string, unknown>)[field]);
  }
  return preset;
}

function readStore(raw: unknown): CardGlobalStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<CardGlobalStore>;
  if (!store.cards || typeof store.cards !== 'object' || Array.isArray(store.cards)) return null;
  const cards: Record<string, CardGlobalPreset> = {};
  for (const [avatar, preset] of Object.entries(store.cards)) {
    const key = avatar.trim();
    const normalized = normalizePreset(preset);
    if (key && !cardGlobalEmpty(normalized)) cards[key] = normalized;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    cards,
  };
}

function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  revision += 1;
  const store: CardGlobalStore = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    cards: JSON.parse(JSON.stringify(cardGlobalStore.cards)) as Record<string, CardGlobalPreset>,
  };
  ctx.extensionSettings[CARD_GLOBAL_KEY] = store;
  fingerprint = fingerprintOf(store.cards);
  ctx.saveSettingsDebounced?.();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(CARD_GLOBAL_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Image' },
      }),
    );
  }
}

function applyStore(store: CardGlobalStore): void {
  const next = fingerprintOf(store.cards);
  revision = Math.max(revision, store.revision);
  if (next === fingerprint) return;
  cardGlobalStore.cards = store.cards;
  fingerprint = next;
}

function bindListener(): void {
  if (listenerBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listenerBound = true;
  window.addEventListener(CARD_GLOBAL_EVENT, () => {
    const ctx = getContext();
    const store = readStore(ctx?.extensionSettings?.[CARD_GLOBAL_KEY]);
    if (store) applyStore(store);
  });
}

/* ============ 当前角色卡识别 ============ */

/** 当前单角色聊天的角色卡 avatar;群聊(groupId)/未打开聊天/取不到 avatar 时为 null。 */
export function currentCardAvatar(): string | null {
  const ctx = getContext();
  if (!ctx) return null;
  if (ctx.groupId) return null; // 群聊:多角色,没有单一「当前卡」
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const character = ctx.characters?.[Number(idx)];
  const avatar = character?.avatar;
  return typeof avatar === 'string' && avatar.trim() ? avatar.trim() : null;
}

/** 刷新 currentCardKey/currentCardLabel(挂 CHAT_CHANGED;init 与测试也可直呼)。 */
export function refreshCurrentCard(): void {
  const ctx = getContext();
  currentCardKey.value = currentCardAvatar();
  if (!ctx || ctx.groupId) {
    currentCardLabel.value = null;
    return;
  }
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') {
    currentCardLabel.value = null;
    return;
  }
  const name = ctx.characters?.[Number(idx)]?.name;
  currentCardLabel.value = typeof name === 'string' && name.trim() ? name.trim() : null;
}

function bindCardListener(): void {
  if (cardListenerBound) return;
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx.eventTypes?.CHAT_CHANGED) return;
  cardListenerBound = true;
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, refreshCurrentCard);
}

/* ============ 读写 ============ */

/** 取某张卡的设定副本;没有则返回空设定(不落库)。 */
export function cardGlobalOf(avatar: string): CardGlobalPreset {
  const preset = cardGlobalStore.cards[avatar.trim()];
  return preset ? { ...preset } : emptyCardGlobalPreset();
}

/**
 * 保存某张卡的设定(仅用户手动路径调用)。
 * 全字段为空 → 视为清除:删除该卡条目,库不留空壳。
 * 返回是否引起存储变化(写库或删除都算;内容没变也照常落盘,返回 true)。
 */
export function saveCardGlobal(avatar: string, preset: CardGlobalPreset): boolean {
  const key = avatar.trim();
  if (!key) return false;
  const normalized = normalizePreset(preset);
  if (cardGlobalEmpty(normalized)) {
    if (!(key in cardGlobalStore.cards)) return false;
    delete cardGlobalStore.cards[key];
  } else {
    cardGlobalStore.cards[key] = normalized;
  }
  persist();
  return true;
}

/* ============ 提示词注入 ============ */

/** 把设定渲染成发给 AI 的设定块;全空返回 ''(调用方据此不占消息位)。 */
export function cardGlobalPromptText(preset: CardGlobalPreset): string {
  const lines: string[] = [];
  for (const field of CARD_GLOBAL_FIELDS) {
    const value = preset[field]?.trim();
    if (value) lines.push(`${CARD_GLOBAL_FIELD_LABELS[field]}=${value}`);
  }
  if (!lines.length) return '';
  return [
    '【角色卡全局设定】[用户手动维护；对本次全部画面生效，优先于你的默认审美与习惯]',
    ...lines,
    '执行要求：画风写进每张图提示词的整体风格描述；全局生成倾向作用于选图、构图、氛围与光线；角色生成倾向作用于角色入镜时的取景与描写侧重。设定与目标正文明确冲突时以正文事实为准，其余情况一律贯彻。',
  ].join('\n');
}

/** 当前卡的设定块(自动 tag 主流程入口);无卡/群聊/未配置 → ''。 */
export function resolveCardGlobalText(): string {
  const avatar = currentCardAvatar();
  if (!avatar) return '';
  return cardGlobalPromptText(cardGlobalOf(avatar));
}

/** 启动初始化:领养已有数据、挂广播监听、识别当前卡并跟随换卡。 */
export function initCardGlobal(): void {
  const ctx = getContext();
  if (ctx?.extensionSettings) {
    const store = readStore(ctx.extensionSettings[CARD_GLOBAL_KEY]);
    if (store) applyStore(store);
  }
  bindListener();
  bindCardListener();
  refreshCurrentCard();
}
