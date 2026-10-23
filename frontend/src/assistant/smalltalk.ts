/**
 * Replies to pure small talk, without a model.
 *
 * "hello" went through the whole research-and-cite pipeline and came back as
 * statistics, or withheld (observed 2026-10-23). A message that is only a
 * greeting, thanks or goodbye needs no data, so the page answers it at once;
 * anything more ("hi, what's burning in Odisha?") still goes to the model.
 */

const CLEAN = /[\s!.?,~:;)(*'"-]+$/g;

const RULES: [RegExp, string][] = [
  [
    /^(?:hi+|hello+|hey+|hiya|yo|namaste|namaskar|good (?:morning|afternoon|evening|day))(?: (?:there|team|all|everyone|bot|heatdetect))?$/i,
    "Hi! Ask me anything about the heat data — a state, a city, the last 24 hours, or one spot on the map.",
  ],
  [
    /^(?:how are you(?: doing)?|how's it going|how is it going|what's up|whats up|sup)$/i,
    "Doing well, thanks! What would you like to look into?",
  ],
  [
    /^(?:thanks|thank you|thank u|thx|ty|cheers|great|awesome|cool|nice|perfect|got it|ok(?:ay)?|k)(?: (?:so much|a lot|very much|man|bro|buddy))?$/i,
    "You're welcome! Anything else you'd like to check?",
  ],
  [/^(?:bye|goodbye|see you|see ya|cya|good night)$/i, "Bye! Come back any time."],
];

/** The reply to a message that is only small talk, or null for anything else. */
export function smallTalk(message: string): string | null {
  const text = message.trim().replace(CLEAN, "").replace(/\s+/g, " ");
  if (!text || text.length > 40) return null;
  for (const [pattern, reply] of RULES) if (pattern.test(text)) return reply;
  return null;
}
