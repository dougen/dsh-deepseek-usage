/**
 * dsh-deepseek-usage — provider 映射解析。
 *
 * 有些第三方插件会注册自己的 provider 路由（例如 dsh-opencode-go 注册的
 * `dsh-opencode-go`），它调用的是同一个厂商的订阅账户，但 provider id 不在
 * lib/accounts.js 的能力表里，插件就认不出来。这里给用户一个显式入口：在插件
 * 设置页把「路由 id → 受支持提供商」写成映射，解析时按映射套用该提供商的端点
 * 与凭据引用。
 *
 * 识别顺序固定：**精确 id 优先**（能力表是权威，映射不能覆盖已支持的路由），
 * 命中不了才查用户映射；都不命中返回 null，调用方按「不支持」处理。
 *
 * 不按名字、不按端点猜：网关或中转可以起任何名字、指向任何地址，猜出来的读数
 * 与账单无关，正是本插件一直避免的情况。
 */

import { accountCapabilityOf, aliasableProviderIds, candidateRefsOf } from './accounts.js';

/** 凭据引用名：DSH 与插件都用大写环境变量名。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** provider id 的宽松上限；不限制字符集，只挡掉空白与异常长度。 */
const MAX_PROVIDER_ID_LENGTH = 128;

/**
 * 把配置里的映射整理成可查询的 Map。
 *
 * 接受 `[{ provider, capability, refs? }]`；非法项整体丢弃并记一条 warning
 * （由调用方写进日志，避免坏配置静默生效）。重复 provider 取第一条。
 *
 * schemastery 的 `volatile()` 字段在 Cordis 校验后会包成带 `get()` 的引用对象
 * （设置页要就地更新表单），这里先解包；普通数组原样使用。
 *
 * @param {unknown} raw `config.providerAliases`
 * @returns {{ aliases: Map<string, { provider: string, capability: string, refs: string[] }>, warnings: string[] }}
 */
export function normalizeAliases(raw) {
  const aliases = new Map();
  const warnings = [];
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.get === 'function') {
    try {
      return normalizeAliases(raw.get());
    } catch {
      warnings.push('providerAliases 无法读取，已忽略');
      return { aliases, warnings };
    }
  }
  if (raw === undefined || raw === null) return { aliases, warnings };
  if (!Array.isArray(raw)) {
    warnings.push('providerAliases 不是数组，已忽略');
    return { aliases, warnings };
  }

  const aliasable = new Set(aliasableProviderIds());
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push('忽略了一条不是对象的 provider 映射');
      continue;
    }
    const provider = typeof item.provider === 'string' ? item.provider.trim() : '';
    const capability = typeof item.capability === 'string' ? item.capability.trim() : '';
    if (provider === '' || provider.length > MAX_PROVIDER_ID_LENGTH || /\s/.test(provider)) {
      warnings.push('忽略了一条 provider id 非法的映射');
      continue;
    }
    if (!aliasable.has(capability)) {
      warnings.push(`忽略映射 ${provider}：目标提供商 "${capability}" 不可映射`);
      continue;
    }
    const key = provider.toLowerCase();
    if (aliases.has(key)) {
      warnings.push(`忽略重复的 provider 映射：${provider}`);
      continue;
    }
    const refs = Array.isArray(item.refs)
      ? [...new Set(item.refs
        .filter((ref) => typeof ref === 'string')
        .map((ref) => ref.trim())
        .filter((ref) => REF_PATTERN.test(ref)))]
      : [];
    aliases.set(key, { provider, capability, refs });
  }
  return { aliases, warnings };
}

/**
 * 造一个解析器。`resolve(id)` 返回
 * `{ id, capabilityId, entry, refs, via }`（via 为 'exact' 或 'alias'），
 * 未识别返回 null。
 *
 * @param {Map<string, { provider: string, capability: string, refs: string[] }>} aliases
 */
export function createProviderResolver(aliases = new Map()) {
  const table = aliases instanceof Map ? aliases : new Map();

  /** 用户映射的候选引用：显式引用 → 该路由自己的派生引用 → 能力表默认引用。 */
  function aliasRefs(provider, refs, entry) {
    const derived = `${String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
    return [...new Set([...refs, derived, ...(entry.refs ?? [])])];
  }

  return {
    /** 配置里实际生效的映射条数（诊断用）。 */
    get size() {
      return table.size;
    },
    /**
     * @param {unknown} id 原始 provider id（来自 agentDefaultModel）
     * @returns {null | { id: string, capabilityId: string, entry: object, refs: string[], via: 'exact' | 'alias' }}
     */
    resolve(id) {
      const raw = typeof id === 'string' ? id.trim() : '';
      if (raw === '') return null;

      // 1. 精确 id：能力表是权威，永远优先。
      const exact = accountCapabilityOf(raw);
      if (exact !== null) {
        return {
          id: raw,
          capabilityId: exact.id,
          entry: exact,
          refs: candidateRefsOf(exact.id),
          via: 'exact',
        };
      }

      // 2. 用户映射：只对能力表里没有的路由生效。
      const alias = table.get(raw.toLowerCase());
      if (alias === undefined) return null;
      const entry = accountCapabilityOf(alias.capability);
      if (entry === null) return null;
      return {
        id: raw,
        capabilityId: entry.id,
        entry,
        refs: aliasRefs(raw, alias.refs, entry),
        via: 'alias',
      };
    },
  };
}
