/**
 * Runtime admission policy for facts emitted by the ongoing-interaction
 * historian. This is deliberately conservative: language matching can only
 * reject unsafe candidates; it cannot establish that a statement is true.
 * Source/provenance checks remain a separate required promotion boundary.
 */

const PROHIBITED_OPERATIONAL_OR_TRANSIENT = [
    /\b(?:tool(?:\s+call)?|tool\s+result|receipt|snapshot|live[-\s]+world|current[-\s]+(?:world|state|location|inventory)|inventory|ordinary\s+(?:task|activity)|action\s+result|result|failure|failed|recover(?:y|ed)?|retry|planner|planning|plan(?:ner)?\s+experience|process|route|harvest|completed?)\b/iu,
    /\b(?:tool_result|tool_call|live_world|current_state|current_inventory|action_receipt|task_result)\b/iu,
    /(?:工具(?:调用|结果)?|收据|回执|快照|结果|实时世界|当前(?:世界|状态|位置|库存)|库存|普通(?:任务|活动)|动作结果|失败|重试|恢复|规划|计划|流程|路线|收获|完成)/u,
];

const EXPLICIT_SEMANTIC_MARKER = [
    /\b(?:explicit(?:ly)?\s+(?:said|stated|confirmed|prefers?|agreed)|confirmed\s+(?:a|the)\s+(?:durable\s+)?(?:preference|boundary|agreement)|player\s+(?:prefers?|confirmed|explicitly))\b/iu,
    /(?:明确(?:表示|说明|确认|偏好)|确认了?(?:长期|持久)?(?:偏好|边界|约定)|玩家(?:偏好|明确确认))/u,
];

const EXPLICIT_INTERACTION_MARKER = [
    /\b(?:explicit(?:ly)?\s+(?:agreed|confirmed|committed)|(?:player|we|they)\s+(?:agreed|promise(?:d)?|committed)|agreement|commitment|promise|boundary|ritual|unresolved\s+(?:topic|thread|question)|resume\s+(?:the\s+)?(?:named\s+)?(?:topic|thread|question)|relationship\s+arc|consequential\s+(?:relationship|conversation|interaction)\s+arc)\b/iu,
    /(?:明确(?:同意|约定|承诺|答应)|(?:约定|承诺|边界|仪式)|未解决(?:的话题|线程|问题)|(?:话题|线程|问题).*(?:稍后|以后|继续)|关系.*(?:发展|弧线|修复|转折))/u,
];

function matchesAny(patterns: readonly RegExp[], content: string): boolean {
    return patterns.some((pattern) => pattern.test(content));
}

/**
 * Return true only when an ongoing-interaction historian fact has a concrete
 * durable marker and contains no operational/transient material. INTERACTION
 * episodes require an interaction marker; semantic facts require explicit
 * confirmation. Unknown categories are rejected.
 */
export function isOngoingInteractionDurableFactAdmissible(
    category: string,
    content: string,
): boolean {
    if (
        (category !== "SEMANTIC_MEMORY" && category !== "INTERACTION_EPISODE") ||
        typeof content !== "string" ||
        content.trim().length === 0
    ) {
        return false;
    }

    const normalized = content.trim();
    if (matchesAny(PROHIBITED_OPERATIONAL_OR_TRANSIENT, normalized)) return false;
    return category === "INTERACTION_EPISODE"
        ? matchesAny(EXPLICIT_INTERACTION_MARKER, normalized)
        : matchesAny(EXPLICIT_SEMANTIC_MARKER, normalized);
}
