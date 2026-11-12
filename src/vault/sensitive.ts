// Sensitive-personal-detail POLICY (AGENTS.md section 4: "recording a new category of sensitive personal detail ... needs Rai's
// approval"). This is not credential recognition (filter.ts) and not authorization (the confirmation flow in edit.ts, tools.ts and
// clone.ts): it only answers "does this inserted text look like a new category of personal detail that Rai must approve?". The
// answer routes a write to a confirmation card; it never blocks a write outright and never masks anything.
// Categories of sensitive personal detail that need Rai's confirmation before ORBIT records them (AGENTS.md section 4). This is a
// keyword screen. It is conservative, not complete: it asks for every occurrence of the condition-bearing words below unless the
// sentence is demonstrably technical (see healthScreen), and it can still miss a disclosure that names a condition, drug or
// treatment it does not list (the lists below are finite, and no word list can be a complete privacy control). A category
// already present in the note is not "new", so adding to an established note is not blocked by what is already there.
//
// Health, in two tiers:
//  - HEALTH_ALWAYS: condition, treatment and drug words (and "diagnosed with", "prescribed <thing>", "has a heart condition"
//    style phrases). They count wherever they appear; there is no technical exemption for them.
//  - HEALTH_AMBIGUOUS: words that are also everyday technical vocabulary, matched as broadly as before (diagnos*, prescri*,
//    symptom*, chronic, disorder*, and "has a ... condition"). Each sentence containing one is flagged unless it is demonstrably
//    technical: it has a technical cue word (service, build, queue, ...) and NO personal cue (a pronoun, a possessive such as
//    "Sam's", "was diagnosed/prescribed", a medical-setting word such as doctor or clinic, or a capitalised name that does not
//    start the sentence). A bare pronoun requirement is not used: names, possessives and passives are personal too.
// Known limits: a technical sentence that also happens to hold a personal cue is asked about (over-matching); a disclosure that
// uses none of the listed words, or hides a condition behind slang or a misspelling, is not caught.
const HEALTH_ALWAYS = new RegExp(
  [
    "psychiatr\\w+|psycholog\\w+|depress(?:ed|ion|ive)|anxiety|cancer|tumou?r|hiv|pregnan\\w+|illness|surgery|medicat\\w+|therap(?:y|ist)\\w*|prescription\\w*|blood pressure|mental health|antibiotics?",
    "adhd|ocd|ptsd|bipolar|schizo\\w*|diabet\\w+|asthma\\w*|epilep\\w+|autis(?:m|tic)|dementia|alzheimer\\w*|parkinson\\w*|arthritis|anorexia|bulimi\\w+|migraines?|insomnia|dyslexi\\w+|leukemia|lymphoma|hepatitis|tuberculosis|covid\\w*",
    "(?:heart|kidney|liver|lung|autoimmune|thyroid) (?:condition|disease|failure|attack|murmur|problems?|issues?)",
    "sertraline|fluoxetine|prozac|zoloft|lexapro|escitalopram|citalopram|paroxetine|venlafaxine|bupropion|lithium|xanax|valium|klonopin|adderall|ritalin|insulin|metformin|statins?|ibuprofen|amoxicillin|opioids?|oxycodone|methadone|gabapentin|ozempic|antidepressants?|antipsychotics?",
    "crohn['’]?s(?: disease)?|lupus|multiple sclerosis|chemo(?:therapy)?|rehab(?:ilitation)?",
    // MS and MS-style acronyms are matched only with a clear personal/medical frame, never bare (MS Office, MS SQL, ms for milliseconds).
    "(?:has|have|had|diagnosed with|living with|suffers? from|suffering from) (?:an? |the )?ms\\b",
    "diagnosed (?:with|me|him|her|them)|diagnosis of",
    "(?:was|were|been|got|being|is|are) (?:\\w+ )?prescribed|prescribed (?:me|him|her|them|\\d+\\w*|an?|some|medication|medicine|drugs?|pills?)",
    "chronic (?:pain|illness|fatigue|condition|disease|migraines?|headaches?|insomnia|asthma|back|stress)",
    "(?:anxiety|bipolar|eating|sleep|mood|personality|panic|autism|attention|mental|seizure|stress) disorders?",
  ].join("|").replace(/^/, "\\b(?:").concat(")\\b"),
  "i",
);
// Ambiguous tier: words that are also everyday technical vocabulary. A sentence holding one is asked about (confirmation card)
// unless it is demonstrably technical: it has a technical cue word (service, build, queue, ...) and no person frame (a pronoun,
// a capitalised possessive such as "Sam's", a was/is diagnosed passive, a capitalised name mid-sentence) and no medical-setting word.
// The default is to confirm, so "Sam's diagnosis notes: pending", "He has a condition" and a bare "diagnosis: pending" all ask.
// Generic words such as note, notes, vault, orbit and tool are NOT technical cues: they appear in personal notes too and must not
// suppress a disclosure. "diagnostics", "the build's symptoms", "chronic CI failures" and "has a race condition" remain usable.
// Limits: a technical sentence that also holds a person frame is asked about (over-matching, accepted); a disclosure that uses
// none of the listed words, or hides a condition behind slang or a misspelling, is not caught. This is a convenience screen.
const HEALTH_AMBIGUOUS = /\b(?:diagnos(?:is|es|ed|e|ing)|prescri(?:be|bed|bes|bing|ption|ptions)|symptoms?|chronic|disorders?|(?:has|have|had|living with|suffers? from|suffering from|struggles? with) (?:an? |the )?(?:\w+ ){0,2}(?:condition|disease|syndrome))\b/i;
const TECHNICAL_CUE = /\b(?:services?|servers?|systems?|build|builds|tests?|ci|cd|pipelines?|jobs?|queues?|logs?|errors?|failures?|failing|fails|timeouts?|retr(?:y|ies)|locks?|endpoints?|apis?|deploy\w*|latency|cpu|memory|disk|network|dns|databases?|db|cache|crash\w*|bugs?|incidents?|outages?|monitor\w*|metrics?|daemons?|process(?:es)?|runtime|kernel|https?|tls|ssl|containers?|hosts?|clusters?|events?|format|schema|config\w*|scripts?|code|stack|traces?|debug\w*|health checks?|dashboards?|race condition|regression)\b/i;
// Words that put the sentence in a medical setting: these frame it as personal whatever else it says.
const MEDICAL_SETTING = /\b(?:patients?|doctors?|dr|nurses?|hospital|clinic\w*|medical|medicine|pharmac\w+|physician|gp)\b/i;
// A person frame: a pronoun or possessive for a person, a was/is diagnosed/prescribed passive, or a capitalised name that does not start the sentence.
const PERSON_CUE = /\b(?:my|me|mine|his|her|hers|him|their|them|your|yours|he|she|they)\b|\bI\b|\b[A-Z][a-z]+['’]s\b|\b(?:was|were|been|got|being|is|are) (?:\w+ )?(?:diagnosed|prescribed)\b|\bdiagnosed with\b/;
const NAME_CUE = /(?<=[a-z,;:)] )[A-Z][a-z]+\b/;

function healthScreen(text: string): boolean {
  if (HEALTH_ALWAYS.test(text)) return true;
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (!HEALTH_AMBIGUOUS.test(sentence)) continue;
    if (MEDICAL_SETTING.test(sentence)) return true;
    // Technical only when a technical cue is present AND no person frame is. A sentence with neither (a bare "diagnosis: pending",
    // "He has a condition" is caught by the pronoun) is asked about, as it was before: the default is to confirm.
    if (!TECHNICAL_CUE.test(sentence) || PERSON_CUE.test(sentence) || NAME_CUE.test(sentence)) return true;
  }
  return false;
}

const SENSITIVE: [string, (t: string) => boolean][] = [
  ["health", healthScreen],
  ...([
    ["finances", /\b(bank account|account number|routing number|credit card|salary|net worth|tax return|mortgage|debt|loan balance|income of)\b/i],
    ["identity documents", /\b(passport|social security|ssn|driver'?s licen[cs]e|national id|date of birth|home address)\b/i],
    ["sexual or relationship detail", /\b(sexual\w*|orientation|affair|divorce|breakup|dating)\b/i],
    ["religion or politics", /\b(religio\w+|church|synagogue|mosque|vote[ds]? for|political part\w+)\b/i],
    ["legal or immigration", /\b(lawsuit|arrest\w*|convict\w*|criminal record|immigration|visa status|asylum|custody)\b/i],
    ["family members' private details", /\b(my (son|daughter|child|kid|wife|husband|partner|mother|father)'?s? (health|diagnos\w+|school|grades))\b/i],
  ] as [string, RegExp][]).map(([n, re]): [string, (t: string) => boolean] => [n, (t) => re.test(t)]),
];

export function sensitiveCategories(inserted: string, before: string): string[] {
  return SENSITIVE.filter(([, hit]) => hit(inserted) && !hit(before)).map(([name]) => name);
}
