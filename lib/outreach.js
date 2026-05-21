const DEFAULT_OUTREACH_TERMS = [
  'website',
  'site',
  'google',
  'demo',
  'built',
  'business',
  'quick',
  'szakacs media',
  'http://',
  'https://',
];

const RISK_PATTERNS = [
  { label: 'stop', pattern: /\bstop\b/i },
  { label: 'unsubscribe', pattern: /\bunsubscribe\b/i },
  { label: 'remove_me', pattern: /\b(remove me|take me off|do not contact)\b/i },
  { label: 'wrong_number', pattern: /\b(wrong number|wrong person|who is this)\b/i },
  { label: 'not_interested', pattern: /\b(not interested|no thanks|no thank you|not at this time|not now)\b/i },
  { label: 'spam', pattern: /\bspam\b/i },
];

const POSITIVE_PATTERNS = [
  /\b(yes|yeah|yep|sure|ok|okay|interested)\b/i,
  /\b(send|share|text).*\b(info|details|link)\b/i,
  /\b(how much|cost|price|pricing|quote)\b/i,
  /\b(call|talk|meeting|meet|tomorrow|today)\b/i,
  /\b(tell me more|learn more|sounds good)\b/i,
];

const UNCLEAR_PATTERNS = [
  /\b(who is this|what is this|what business|which business|huh|sorry)\b/i,
  /^\s*\?\s*$/,
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseLocalDate(value) {
  if (value instanceof Date) return value;
  if (!value) return null;
  return new Date(String(value).replace(' ', 'T'));
}

function sameLocalDay(a, b) {
  const left = parseLocalDate(a);
  const right = parseLocalDate(b);
  if (!left || !right || Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return false;
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function isWithinHours(message, hoursAgo, now = new Date()) {
  if (!hoursAgo) return true;
  const date = parseLocalDate(message.date);
  if (!date || Number.isNaN(date.getTime())) return false;
  return now.getTime() - date.getTime() <= hoursAgo * 60 * 60 * 1000;
}

function detectRiskLabels(text) {
  const normalized = normalizeText(text);
  return RISK_PATTERNS
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ label }) => label);
}

function hasOutreachMarker(text, outreachTerms = DEFAULT_OUTREACH_TERMS) {
  const normalized = normalizeText(text).toLowerCase();
  return outreachTerms.some(term => normalized.includes(String(term).toLowerCase()));
}

function classifyReply(text) {
  const normalized = normalizeText(text);
  const risk_labels = detectRiskLabels(normalized);
  if (risk_labels.length > 0) {
    return {
      status: 'negative_or_opt_out',
      confidence: 'high',
      risk_level: 'high',
      risk_labels,
      reason: 'Reply matched opt-out or negative language.',
    };
  }

  if (POSITIVE_PATTERNS.some(pattern => pattern.test(normalized))) {
    return {
      status: 'candidate',
      confidence: 'high',
      risk_level: 'low',
      risk_labels: [],
      reason: 'Reply matched positive or buying-intent language.',
    };
  }

  if (UNCLEAR_PATTERNS.some(pattern => pattern.test(normalized))) {
    return {
      status: 'unclear',
      confidence: 'low',
      risk_level: 'medium',
      risk_labels: [],
      reason: 'Reply is ambiguous and needs agent judgment.',
    };
  }

  return {
    status: 'candidate',
    confidence: 'medium',
    risk_level: 'low',
    risk_labels: [],
    reason: 'Aggressive mode includes non-negative replies.',
  };
}

function makeSnippet(message) {
  if (!message) return null;
  return {
    message_id: message.message_id,
    date: message.date,
    from_me: Boolean(message.from_me),
    handle: message.handle || null,
    display_name: message.display_name || null,
    text: normalizeText(message.decoded_text || message.text).slice(0, 500),
  };
}

function classifyConversation(chat, options = {}) {
  const now = options.now || new Date();
  const hoursAgo = options.hours_ago || 168;
  const outreachTerms = Array.isArray(options.outreach_terms) && options.outreach_terms.length > 0
    ? options.outreach_terms
    : DEFAULT_OUTREACH_TERMS;
  const messages = [...(chat.messages || [])]
    .filter(message => normalizeText(message.decoded_text || message.text).length > 0)
    .sort((a, b) => {
      const left = parseLocalDate(a.date);
      const right = parseLocalDate(b.date);
      return left - right;
    });

  const outreachIndex = messages.reduce((latestIndex, message, index) => {
    if (!message.from_me) return latestIndex;
    if (!isWithinHours(message, hoursAgo, now)) return latestIndex;
    if (!hasOutreachMarker(message.decoded_text || message.text, outreachTerms)) return latestIndex;
    return index;
  }, -1);

  if (outreachIndex === -1) return null;

  const outreach = messages[outreachIndex];
  const afterOutreach = messages.slice(outreachIndex + 1);
  const inbound = afterOutreach.filter(message => !message.from_me);
  const firstReply = inbound[0] || null;

  if (!firstReply) {
    return {
      candidate_id: `${chat.chat_id}:${outreach.message_id}:none`,
      status: 'awaiting_reply',
      actionable: false,
      chat_id: chat.chat_id,
      display_name: chat.display_name,
      handles: chat.handles || [],
      to: (chat.handles || [])[0]?.handle || null,
      risk_level: 'low',
      risk_labels: [],
      confidence: 'low',
      reason: 'No prospect reply after detected outreach.',
      evidence: {
        outreach: makeSnippet(outreach),
        reply: null,
        follow_up: null,
      },
    };
  }

  const followUps = afterOutreach.filter(message => {
    const replyDate = parseLocalDate(firstReply.date);
    const messageDate = parseLocalDate(message.date);
    return message.from_me && messageDate > replyDate;
  });
  const latestFollowUp = followUps[followUps.length - 1] || null;

  if (latestFollowUp) {
    return {
      candidate_id: `${chat.chat_id}:${outreach.message_id}:${firstReply.message_id}`,
      status: 'already_followed_up',
      actionable: false,
      chat_id: chat.chat_id,
      display_name: chat.display_name,
      handles: chat.handles || [],
      to: (chat.handles || [])[0]?.handle || null,
      risk_level: 'low',
      risk_labels: [],
      confidence: 'high',
      reason: sameLocalDay(latestFollowUp.date, now) ? 'Tyler already followed up today.' : 'Tyler already followed up after the reply.',
      evidence: {
        outreach: makeSnippet(outreach),
        reply: makeSnippet(firstReply),
        follow_up: makeSnippet(latestFollowUp),
      },
    };
  }

  const classification = classifyReply(inbound.map(message => message.decoded_text || message.text).join(' '));

  return {
    candidate_id: `${chat.chat_id}:${outreach.message_id}:${firstReply.message_id}`,
    status: classification.status,
    actionable: true,
    chat_id: chat.chat_id,
    display_name: chat.display_name,
    handles: chat.handles || [],
    to: (chat.handles || [])[0]?.handle || null,
    risk_level: classification.risk_level,
    risk_labels: classification.risk_labels,
    confidence: classification.confidence,
    reason: classification.reason,
    evidence: {
      outreach: makeSnippet(outreach),
      reply: makeSnippet(firstReply),
      follow_up: null,
    },
  };
}

module.exports = {
  DEFAULT_OUTREACH_TERMS,
  classifyConversation,
  classifyReply,
  detectRiskLabels,
  hasOutreachMarker,
  normalizeText,
};
