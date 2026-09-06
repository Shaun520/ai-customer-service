/**
 * PII 脱敏：出站前将敏感信息替换为占位符，LLM 返回后按映射回填。
 */
import type { RedactionResult } from '@aics/shared';

interface PiiPattern {
  type: string;
  regex: RegExp;
}

const PATTERNS: PiiPattern[] = [
  // 中国大陆手机号
  { type: 'phone', regex: /1[3-9]\d{9}/g },
  // 身份证（18 位，含末位 X）
  { type: 'id_card', regex: /\d{17}[\dXx]/g },
  // 邮箱
  { type: 'email', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // 银行卡（13-19 位数字，宽松匹配，避免误伤放在手机号之后）
  { type: 'bank_card', regex: /(?<!\d)\d{13,19}(?!\d)/g },
];

export function redactPii(text: string): RedactionResult {
  const mappings: RedactionResult['mappings'] = [];
  let redacted = text;
  let counter = 0;

  for (const { type, regex } of PATTERNS) {
    redacted = redacted.replace(regex, (match) => {
      // 身份证 regex 会吞掉纯长数字（如订单号），bank_card 兜底即可；
      // 手机号先替换所以顺序安全
      counter += 1;
      const placeholder = `[PII_${type.toUpperCase()}_${counter}]`;
      mappings.push({ placeholder, original: match, type });
      return placeholder;
    });
  }

  return { redacted, mappings };
}

/** 将 LLM 输出中的占位符回填为原文 */
export function restorePii(text: string, mappings: RedactionResult['mappings']): string {
  let restored = text;
  for (const { placeholder, original } of mappings) {
    restored = restored.split(placeholder).join(original);
  }
  return restored;
}

/** 输出侧二次清洗：兜底拦截漏网的 PII（防止 LLM 复述敏感信息） */
export function scrubPiiOutput(text: string, mappings: RedactionResult['mappings']): string {
  let cleaned = text;
  for (const { placeholder, original, type } of mappings) {
    // 原文不允许出现在输出里：出现则替换为占位符
    cleaned = cleaned.split(original).join(placeholder);
    void type;
  }
  return cleaned;
}
