import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import {
  CHAR_TAG_FIELD_LABELS,
  CHAR_TAG_FIELDS,
  applyCharTagOps,
  type CharTagAutoOp,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';
import { getTagGenChannel } from '@/state/settings';

/**
 * 角色固定外貌库的「锚定」侧。
 *
 * 生成 tag 前把库文本(全部条目)拼进请求:AI 看得到每个角色当前的字段值,才能判断
 * 需不需要改;画面 tag 里它照抄库中字段值,不使用占位符。
 *
 * 为什么不用 @角色名 占位符(v0.1.2 起撤回):原设计让 AI 只写 @小雪、由插件替换成
 * 完整字段串,本意是杜绝复述漂移。实测有三个结构性问题:
 * - 同一角色被引用多次时逐次展开,一张图里出现三份完整外貌 + 三个 1boy,
 *   模型据此画出多个重叠躯干(正向权重乘三,负面词压不住)。
 * - 规范里「40 个 tag 以内」的预算无法执行:AI 数 @小雪 是 1 个,实际展开成 6 个。
 * - 库脏数据被无条件放大:动作/场景词误入 outfit 字段时,每次展开都带上它。
 * 库文本本就在同一上下文里、字段值明明白白列着,照抄可见文本比凭记忆复述可靠,
 * 原设计高估了漂移风险。故改回「库只作参考,AI 自己写全」。
 *
 * applyCharRefs 系函数保留:模型偶发写出 @名字 时仍会被替换掉,不至于把字面量
 * 送进生图。即从主路径降级为兜底。
 *
 * 建档由主请求在同一次输出里完成(changes 的 field="new"):柏宝书的中文外貌本来就
 * 随角色参考块发给了主请求,它还额外有世界书、角色卡与目标正文佐证,比独立的转换
 * 请求判断得更准。建档与用档同属一次推理,后续 tag 才能围绕刚确立的外貌协调。
 *
 * 主流程顺序:先落 changes(本楼发生的变化当楼生效) → 再兜底替换残留的 @占位符。
 */

/** 把库条目渲染成给 AI 看的一行(字段式明细 + 占位符提示);锁定条目带 [locked] 标记。 */
export function formatEntryForPrompt(entry: CharTagEntry, locked = false): string {
  const parts: string[] = [];
  for (const f of CHAR_TAG_FIELDS) {
    const v = entry.fields[f]?.trim();
    if (v) parts.push(`${CHAR_TAG_FIELD_LABELS[f]}=${v}`);
  }
  if (!parts.length && entry.raw.trim()) parts.push(`tag=${entry.raw.trim()}`);
  if (entry.nl.trim()) parts.push(`nl=${entry.nl.trim()}`);
  return `- ${entry.name}${locked ? ' [locked]' : ''}: ${parts.join(', ') || '(未记录字段)'}`;
}

/**
 * 库文本:发给 AI 的角色库部分。AI 依据它决定 changes,并在 tag/nl 中照抄对应字段;
 * 名单与字段值都由插件生成,AI 只读。锁定名(全局库)带 [locked] 标记并在头部声明不可变。
 */
export function buildLibraryText(entries: CharTagEntry[], lockedNames?: ReadonlySet<string>): string {
  if (!entries.length) return '';
  const lines = entries.map(entry => formatEntryForPrompt(entry, lockedNames?.has(entry.name) ?? false));
  const lockedNote = lockedNames?.size
    ? '；标 [locked] 的是全局锁定档案：不得为其报告任何变化，字段值原样照抄'
    : '';
  return `【角色固定外貌库】[系统维护；字段值照抄进画面提示词${lockedNote}]\n${lines.join('\n')}`;
}

/** 旧接口兼容:runner 之外仍有调用方依赖锚定文本形态。 */
export function buildAnchorText(entries: CharTagEntry[], lockedNames?: ReadonlySet<string>): string {
  return buildLibraryText(entries, lockedNames);
}

/* ============ 中文外貌 → 结构化字段 的批量转换 ============ */

const CONVERT_SPEC = `你是外貌档案转换器。把给出的角色中文外貌描述拆成固定字段的自然中文短语（Baibai-nl:字段值就是中文，不再是英文 tag）。

字段与示例:
- sex(性别):少女 / 少年 / 成年女性 / 男性 等
- age(年龄):18岁 / 二十出头 等(没提就留空)
- race(人种/种族):精灵 / 兽人 / 魔族 / 人类 等(没提就留空)
- height(身高):158cm / 一米六 等(没提就留空)
- hair(头发):乌黑的长发 / 银色短发 等（颜色+长度/发型写在一起）
- eyes(眼睛):蓝色的眼睛 / 红色的眼睛 等
- skin(肤色):晒黑 / 深色皮肤 等(没提就留空;白皙是默认肤色,不需要记录)
- body(体型):娇小 / 高挑 / 纤细 等
- breasts(胸部):贫乳 / 乳房丰满 / 巨乳 等(没提就留空)
- butt(臀部):翘臀 / 臀部丰满 等(没提就留空)
- pussy(阴部):无毛 / 阴部粉嫩 等(没提就留空)
- extra(标志特征):异色瞳 / 脸颊有疤 / 尖耳朵 等(没提就留空)

规则:
1. 只提取固定基础特征;服装、饰品、状态、表情、动作、场景一律不写。
2. hair 与 eyes 是二次元角色身份锚点：描述里只要出现发色、发型/长度或瞳色线索就必须写入对应字段，不得遗漏或塞进 extra；hair 尽量同时保留颜色和长度/发型，eyes 保留颜色。
3. 描述里没提的细节不要脑补,对应字段留空字符串。
4. 只返回一个 JSON 对象:{"角色名":{"sex":"...","age":"...","race":"...","height":"...","hair":"...","eyes":"...","skin":"...","body":"...","breasts":"...","butt":"...","pussy":"...","extra":"..."}},键与输入的角色名完全一致;不要 Markdown 代码块、不要解释。`;

/** 字段值清洗:换行压成空格、剥 bbi_image 系子标签字面量(防止污染注入格式)。 */
function sanitizeTagValue(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (!text) return '';
  if (/<\/?(?:bbi_image|tag|nl|size)\b/i.test(text)) return '';
  return text;
}

/** 从模型回复中解析 {角色名: {字段: tag}}(宽容:带代码块/前后杂质也能解)。 */
export function parseConvertedTags(raw: string): Record<string, Partial<Record<CharTagField, string>>> {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
  const candidates: string[] = [cleaned.trim()];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.unshift(match[1].trim());
  }
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const value: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const out: Record<string, Partial<Record<CharTagField, string>>> = {};
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
          const name = key.trim();
          if (!name || !v || typeof v !== 'object' || Array.isArray(v)) continue;
          const fields: Partial<Record<CharTagField, string>> = {};
          for (const f of CHAR_TAG_FIELDS) {
            const tag = sanitizeTagValue((v as Record<string, unknown>)[f]);
            if (tag) fields[f] = tag;
          }
          if (Object.keys(fields).length) out[name] = fields;
        }
        return out;
      }
    } catch {
      // 试下一个候选
    }
  }
  return {};
}

export interface ConvertedChar {
  name: string;
  desc: string;
  fields: Partial<Record<CharTagField, string>>;
}

/**
 * 批量把中文外貌转成结构化字段。一次请求转换所有待办角色。
 * 渠道与自动 tag 主流程同口径:指派渠道优先,未指派跟随主 API。
 * 返回成功转换的条目;整体失败(请求异常)向上抛,调用方 catch 后降级。
 *
 * 只服务角色管理页的「按柏宝书最新外貌生成」按钮 —— 那是用户主动点的一次性动作。
 * 自动 tag 主流程不再调它:建档由主请求在同一次输出里完成(见文件头)。
 */
export async function generateCharTags(
  chars: Array<{ name: string; desc: string }>,
  signal?: AbortSignal,
): Promise<ConvertedChar[]> {
  if (!chars.length) return [];
  const messages: ChatMsg[] = [
    { role: 'system', content: CONVERT_SPEC },
    {
      role: 'user',
      content: chars.map(c => `- ${c.name}: ${c.desc}`).join('\n'),
    },
  ];
  const channel = getTagGenChannel();
  const raw = channel
    ? await requestCompletion(channel, messages, { signal, source: '角色外貌转换' })
    : await requestViaMainApi(messages, { signal, source: '角色外貌转换' });
  const parsed = parseConvertedTags(raw);
  const out: ConvertedChar[] = [];
  for (const c of chars) {
    const fields = parsed[c.name];
    if (fields) out.push({ name: c.name, desc: c.desc, fields });
  }
  return out;
}

/* ============ 按用户描述补充字段（角色编辑弹窗） ============ */

const SUPPLEMENT_SPEC = `你是外貌档案补充器。用户会给出角色当前的字段档案和一段补充描述，把描述里的外貌信息合并进字段，返回合并后的完整档案。

字段与口径（Baibai-nl：全部用自然中文短语）：
- fandom（同人身份）：「《作品名》的角名」，如「《原神》的甘雨」；原创角色留空
- sex（性别）：少女 / 少年 / 成年女性 / 男性 等
- age（年龄）：18岁 / 二十出头 等（没提就留空）
- race（人种/种族）：精灵 / 兽人 / 魔族 / 人类 等（没提就留空）
- height（身高）：158cm / 一米六 等（没提就留空）
- hair（头发）：乌黑的长发 / 银色短发 等（颜色+长度/发型写在一起）
- eyes（眼睛）：蓝色的眼睛 / 红色的眼睛 等
- skin（肤色）：晒黑 / 深色皮肤 等（没提就留空；白皙是默认肤色，不需要记录）
- body（体型）：娇小 / 高挑 / 纤细 等
- breasts（胸部）：贫乳 / 乳房丰满 / 巨乳 等（没提就留空）
- butt（臀部）：翘臀 / 臀部丰满 等（没提就留空）
- pussy（阴部）：无毛 / 阴部粉嫩 等（没提就留空）
- extra（标志特征）：异色瞳 / 脸颊有疤 / 尖耳朵 等
- outfit（固定着装）：描述明确该服装长期固定不变（如「总是穿」「招牌装束」）才写；一次性或当前穿着不写

规则：
1. 描述明确提到的特征写进对应字段；描述与当前值冲突时以描述为准（用户就是在要求修改）。
2. 描述没提到的字段原样返回当前值；当前为空且描述也没提的字段留空。
3. 不要脑补描述之外的细节。
4. 动作、姿势、表情、临时状态、所在场景一律不写。
5. 只返回一个 JSON 对象，形如 {"fandom":"","sex":"少女","age":"","race":"","height":"","hair":"银色长发","eyes":"红色的眼睛","skin":"","body":"","breasts":"","butt":"","pussy":"","extra":"","outfit":""}，全部十四个字段都带；不要 Markdown 代码块、不要解释。`;

/**
 * 解析补充器的扁平返回 {字段: 值}(宽容:带 think 块/代码块/前后杂质也能解)。
 * 解析不出任何 JSON 对象 → null;解出来但无非空字段 → {}(区别于「没返回」)。
 */
export function parseSupplementFields(raw: string): Partial<Record<CharTagField, string>> | null {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
  const candidates: string[] = [cleaned.trim()];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.unshift(match[1].trim());
  }
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const value: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const out: Partial<Record<CharTagField, string>> = {};
        for (const f of CHAR_TAG_FIELDS) {
          const tag = sanitizeTagValue((value as Record<string, unknown>)[f]);
          if (tag) out[f] = tag;
        }
        return out;
      }
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

/**
 * 按用户的一段描述补充/修正角色字段:当前档案 + 描述 一起发给模型,返回合并后的非空字段。
 * 只返回描述涉及(或原本有值)的字段;调用方按「非空才覆盖」合并,模型失误清不掉用户字段。
 * 渠道与 generateCharTags 同口径;解析失败抛错,调用方 catch 后提示重试。
 */
export async function supplementCharTags(
  name: string,
  request: string,
  fields: Record<CharTagField, string>,
  signal?: AbortSignal,
): Promise<Partial<Record<CharTagField, string>>> {
  const specLines = CHAR_TAG_FIELDS.map(
    f => `- ${CHAR_TAG_FIELD_LABELS[f]}：${fields[f]?.trim() || '（空）'}`,
  ).join('\n');
  const messages: ChatMsg[] = [
    { role: 'system', content: SUPPLEMENT_SPEC },
    {
      role: 'user',
      content: `角色名：${name}\n\n当前档案：\n${specLines}\n\n用户描述：\n${request.trim()}`,
    },
  ];
  const channel = getTagGenChannel();
  const raw = channel
    ? await requestCompletion(channel, messages, { signal, source: '角色外貌补充' })
    : await requestViaMainApi(messages, { signal, source: '角色外貌补充' });
  const parsed = parseSupplementFields(raw);
  if (!parsed) throw new Error('模型没有返回可解析的字段结果，请重试或换个说法');
  return parsed;
}

/* ============ 主流程入口 ============ */

/**
 * 生成前的库准备:把当前库渲染成请求里的库文本。
 *
 * 纯函数、无请求 —— 建档已交给主请求(见文件头)。保留这层是因为调用方还需要
 * 「库文本 + 库条目」这对组合,且 @占位符替换要以同一份 entries 为基线。
 * 空库返回 text=null,调用方据此不启用 @占位符。
 */
export interface ResolvedCharAnchors {
  text: string | null;
  entries: CharTagEntry[];
}

export function resolveCharAnchors(
  entriesBefore: CharTagEntry[],
  lockedNames?: ReadonlySet<string>,
): ResolvedCharAnchors {
  const text = buildLibraryText(entriesBefore, lockedNames);
  return { text: text || null, entries: entriesBefore };
}

/* ============ @占位符 替换 ============ */

/** @名 占位符;名字允许中文/字母/数字/点/下划线/间隔号(常见角色名形态)。 */
const REF_PATTERN = /@([\p{L}\p{N}_.·]+)/gu;

function joinEntryTag(entry: CharTagEntry): string {
  // 与 state/charTags.buildEntryTag 同构;重复这一小段以避开循环依赖
  if (entry.raw.trim() && CHAR_TAG_FIELDS.every(f => !(entry.fields[f] ?? '').trim())) {
    return entry.raw.trim();
  }
  return CHAR_TAG_FIELDS.map(f => (entry.fields[f] ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

/** 压缩替换后残留的分隔符垃圾:连续逗号、行首行尾逗号。 */
function tidySeparators(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/,\s*,/g, ',').replace(/\s+,/g, ',').replace(/,\s+/g, ', ');
    if (next === out) break;
    out = next;
  }
  return out.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '').trim();
}

/**
 * AI 输出文本里的 @占位符 处理:库里有的 → 替换成最新 tag 串(nl 模式优先条目的自然语言句);
 * 没有的 → 剥掉(连带尾随分隔符)。返回处理后的文本与未知名字列表(调用方可用于告警)。
 */
export function applyCharRefs(
  text: string,
  entries: CharTagEntry[],
  mode: 'tag' | 'nl' = 'tag',
): { text: string; unknown: string[] } {
  const byName = new Map(entries.map(e => [e.name, e]));
  const unknown: string[] = [];
  const seen = new Set<string>();
  const replaced = text.replace(REF_PATTERN, (_full, name: string) => {
    const entry = byName.get(name);
    if (entry) {
      if (mode === 'nl' && entry.nl.trim()) return entry.nl.trim();
      return joinEntryTag(entry);
    }
    if (!seen.has(name)) {
      seen.add(name);
      unknown.push(name);
    }
    return '';
  });
  return { text: tidySeparators(replaced), unknown };
}

export interface PositionedCharOp {
  op: CharTagAutoOp;
  sourceLine: number;
}

/**
 * 按图片位置解析 @占位符。
 *
 * 建档(new)全楼生效:新角色的固定外貌是本楼**全程成立的事实**,不是「从某处开始」的
 * 变化——同一楼里位置更靠前的图片也可能有这个角色在场。若按位置门控,那些图片的
 * @占位符会查不到条目而被整个剥掉,角色变成没有外貌。
 * 永久变化(set)才按位置门控:染发之前的图片必须用旧档案。
 */
export function applyPositionedCharRefs(
  text: string,
  entries: CharTagEntry[],
  ops: PositionedCharOp[],
  sourceLine: number,
  mode: 'tag' | 'nl' = 'tag',
  locked?: ReadonlySet<string>,
): { text: string; unknown: string[] } {
  const activeOps = ops
    .filter(item => item.op.kind === 'new' || item.sourceLine <= sourceLine)
    .map(item => item.op);
  return applyCharRefs(text, applyCharTagOps(entries, activeOps, -1, locked), mode);
}
