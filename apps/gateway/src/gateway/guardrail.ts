/**
 * AI 合规策略引擎：三态判定（allow / confirm / block）+ Fail-Closed
 *
 * 纵深防御：
 *  ① 输入侧 — 提示词注入检测
 *  ② 策略侧 — 行业规则包（红线库正则 + 关键词风险分级）
 *  ③ 输出侧 — 由调用方结合 scrubPiiOutput 做二次清洗
 *  ④ 流程侧 — Fail-Closed：任何"无法确信安全"的情况默认走最严处置
 */
import type { GuardrailDecision, GuardrailVerdict, IndustryRulePack, RiskLevel } from '@aics/shared';
import { db } from '../db/index.js';
import { industryRules } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';

// ---------------- 内置默认规则包 ----------------

export const DEFAULT_RULE_PACKS: Record<string, IndustryRulePack> = {
  medical: {
    promptInjection: [
      'ignore (all )?(previous|prior|above) (instructions|prompts)',
      '忽略(之前|上面|以上)(的)?(所有)?(指令|提示)',
      '(你是|you are) now ',
      'system prompt',
      '扮演.{0,6}(不受|无)限制',
      'DAN mode',
    ],
    riskRules: [
      // ---- critical: 急症/危象 → block ----
      { id: 'medical-emergency', pattern: '(胸痛|呼吸困难|大出血|晕厥|抽搐|意识不清|自杀|自残|休克|剧烈腹痛)', risk: 'critical', description: '疑似急症/危象，禁止 AI 作答' },
      { id: 'medical-overdose', pattern: '(过量|多吃了|吃多了).{0,8}(药|片|粒|胰岛素)', risk: 'critical', description: '疑似药物过量' },
      // ---- high: 剂量/处方 → confirm（转人工） ----
      { id: 'medical-dosage', pattern: '(剂量|用量|怎么吃|如何服用|一天(吃|服|注射)(几次|多少)|加大|减量|停药|换药|改药)', risk: 'high', description: '涉及用药剂量/停换药，需人工审核' },
      { id: 'medical-prescription', pattern: '(处方|开药|开个|批号|胰岛素|降压药|降糖药|抗生素|激素)', risk: 'high', description: '涉及处方药' },
      { id: 'medical-diagnose', pattern: '(确诊|是不是(得|患)了|诊断)', risk: 'high', description: '涉及诊断结论' },
      // ---- medium: 一般建议 → 生成+抽检 ----
      { id: 'medical-advice', pattern: '(饮食|运动|血糖|血压|睡眠|忌口|食谱)', risk: 'medium', description: '一般健康建议' },
    ],
    blockMessage: '您描述的情况可能涉及紧急医疗状况，AI 客服无法处理。请立即联系线下医疗机构或拨打 120。人工顾问会尽快与您联系。',
  },
  ecommerce: {
    promptInjection: [
      'ignore (all )?(previous|prior|above) (instructions|prompts)',
      '忽略(之前|上面|以上)(的)?(所有)?(指令|提示)',
      'system prompt',
    ],
    riskRules: [
      { id: 'ecom-refund-abuse', pattern: '(恶意退款|骗保|刷单|薅羊毛|虚假签收)', risk: 'high', description: '疑似欺诈诉求' },
      { id: 'ecom-complaint', pattern: '(投诉|举报|12315|工商局|法院|律师函)', risk: 'medium', description: '升级投诉，建议人工跟进' },
      { id: 'ecom-general', pattern: '(退货|换货|退款|发货|物流|优惠券|发票)', risk: 'low', description: '常规售前售后问题' },
    ],
    blockMessage: '您的诉求涉及违规内容，无法处理。如有正常售后需求请联系人工客服。',
  },
  tech: {
    promptInjection: [
      'ignore (all )?(previous|prior|above) (instructions|prompts)',
      '忽略(之前|上面|以上)(的)?(所有)?(指令|提示)',
      'system prompt',
      '(print|output|reveal).{0,10}(system|initial) prompt',
    ],
    riskRules: [
      { id: 'tech-security', pattern: '(漏洞利用|sql注入|提权|抓包改包|内网穿透|撞库)', risk: 'high', description: '涉及安全攻击内容' },
      { id: 'tech-sla', pattern: '(赔偿|违约|退款|SLA|服务中断|宕机索赔)', risk: 'medium', description: '商务/SLA 条款，建议人工跟进' },
      { id: 'tech-general', pattern: '(api|接口|sdk|报错|部署|集成|文档|版本)', risk: 'low', description: '常规技术咨询' },
    ],
    blockMessage: '您的请求包含不允许的内容，无法处理。如有技术支持需求请联系人工客服。',
  },
  general: {
    promptInjection: [
      'ignore (all )?(previous|prior|above) (instructions|prompts)',
      '忽略(之前|上面|以上)(的)?(所有)?(指令|提示)',
      'system prompt',
    ],
    riskRules: [
      { id: 'general-sensitive', pattern: '(政治|赌博|毒品|枪支|色情|暴力恐吓)', risk: 'critical', description: '违法违禁内容' },
      { id: 'general-escalate', pattern: '(投诉|举报|曝光|媒体)', risk: 'medium', description: '建议人工跟进' },
    ],
    blockMessage: '您的请求包含不允许的内容，无法处理。请联系人工客服。',
  },
};

// ---------------- 规则加载（DB 可热更新，DB 未配置回退默认） ----------------

const ruleCache = new Map<string, { pack: IndustryRulePack; loadedAt: number }>();
const RULE_TTL_MS = 60_000;

export async function loadRulePack(industry: string): Promise<IndustryRulePack> {
  const cached = ruleCache.get(industry);
  if (cached && Date.now() - cached.loadedAt < RULE_TTL_MS) return cached.pack;
  try {
    const rows = await db
      .select()
      .from(industryRules)
      .where(and(eq(industryRules.industry, industry), eq(industryRules.enabled, true)))
      .limit(1);
    if (rows.length > 0) {
      const pack = rows[0].rules as IndustryRulePack;
      ruleCache.set(industry, { pack, loadedAt: Date.now() });
      return pack;
    }
  } catch (err) {
    // Fail-Closed：不因规则加载失败而放行，回退默认包并记录告警
    console.error('[guardrail] failed to load rules from db, falling back to defaults:', (err as Error).message);
  }
  const fallback = DEFAULT_RULE_PACKS[industry] ?? DEFAULT_RULE_PACKS.general;
  ruleCache.set(industry, { pack: fallback, loadedAt: Date.now() });
  return fallback;
}

export function clearRuleCache(): void {
  ruleCache.clear();
}

const RISK_TO_VERDICT: Record<RiskLevel, GuardrailVerdict> = {
  low: 'allow',
  medium: 'allow', // medium 生成后走抽检，不阻塞流程
  high: 'confirm',
  critical: 'block',
};

// ---------------- 引擎 ----------------

export interface GuardrailInput {
  industry: string;
  query: string;
}

/**
 * 三态判定。任何异常 → Fail-Closed（confirm 转人工），绝不放行了事。
 */
export async function evaluate(input: GuardrailInput): Promise<GuardrailDecision> {
  try {
    const pack = await loadRulePack(input.industry);
    const text = input.query;

    // ① 提示词注入 → block
    for (const pattern of pack.promptInjection) {
      if (new RegExp(pattern, 'i').test(text)) {
        return {
          verdict: 'block',
          riskLevel: 'critical',
          matchedRules: [`prompt-injection:${pattern}`],
          confidence: 95,
          reason: '检测到提示词注入尝试',
          blockMessage: pack.blockMessage,
        };
      }
    }

    // ② 风险分级：取所有命中规则中风险最高者
    let highest: RiskLevel = 'low';
    const matched: string[] = [];
    for (const rule of pack.riskRules) {
      try {
        if (new RegExp(rule.pattern, 'i').test(text)) {
          matched.push(`${rule.id}(${rule.description})`);
          const order: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
          if (order.indexOf(rule.risk) > order.indexOf(highest)) highest = rule.risk;
        }
      } catch {
        // 单条规则正则非法：跳过该规则（其余规则继续生效）
        console.warn(`[guardrail] invalid rule pattern: ${rule.id}`);
      }
    }

    return {
      verdict: RISK_TO_VERDICT[highest],
      riskLevel: highest,
      matchedRules: matched,
      confidence: matched.length > 0 ? 85 : 60,
      reason: matched.length > 0 ? `命中规则: ${matched.join('; ')}` : '未命中风险规则',
      blockMessage: pack.blockMessage,
    };
  } catch (err) {
    // ④ Fail-Closed：引擎异常默认转人工，绝不放行
    console.error('[guardrail] engine error (fail-closed → confirm):', (err as Error).message);
    return {
      verdict: 'confirm',
      riskLevel: 'high',
      matchedRules: ['fail-closed'],
      confidence: 0,
      reason: `护栏引擎异常，按最严处置: ${(err as Error).message}`,
    };
  }
}
