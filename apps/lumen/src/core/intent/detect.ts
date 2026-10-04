// Fast, local, bilingual (EN/FR) signal detection for the user's message.
// Runs before generation on every turn, so it must be cheap and never fail.
// A utility LLM can refine these after the turn (see pipeline/analysis.ts).

export type Intent =
  | "greeting"
  | "goodbye"
  | "question"
  | "flirt"
  | "compliment"
  | "insult"
  | "apology"
  | "share_personal"
  | "romantic_advance"
  | "ask_out"
  | "ask_relationship"
  | "affection"
  | "humor"
  | "roleplay_action"
  | "smalltalk";

export interface TurnSignals {
  intent: Intent;
  intents: Intent[];
  /** -1 (hostile) .. 1 (very warm) */
  sentiment: number;
  question: boolean;
  /** Names / relations of third parties mentioned ("my friend Sara"). */
  mentionedPeople: string[];
  /** Third party mentioned in a way that can trigger jealousy. */
  rivalMention: boolean;
  hasAction: boolean;
  /** Hours since the previous message, if known. */
  absenceHours: number;
  wordCount: number;
}

const P = {
  greeting: /^(hi|hey|hello|yo|hiya|good (morning|evening|night)|salut|coucou|bonjour|bonsoir|cc)\b/i,
  goodbye: /\b(bye|good ?night|see you|gotta go|talk (to you )?later|bonne nuit|à plus|a plus|à demain|a demain|je dois y aller|ciao)\b/i,
  compliment:
    /\b(you('re| are) (so |really |very )?(beautiful|gorgeous|cute|pretty|handsome|amazing|smart|funny|sweet|adorable|stunning|hot|perfect|lovely)|you look (great|amazing|good|beautiful|stunning)|love (your|the way you)|(t'es|tu es) (trop |si |vraiment )?(belle|beau|mignonne?|magnifique|drôle|adorable|canon|parfaite?|intelligente?)|j'adore ton|j'aime ton)\b/i,
  flirt:
    /[😉😏😘]|\b(wink|flirt|tease|teasing|come here|come closer|miss(ed)? you|thinking (about|of) you|can't stop thinking|kiss|cuddle|date me|you're mine|tu me manques|je pense à toi|embrasse|bisou|viens (là|ici|plus près)|ma belle|mon beau)\b/iu,
  insult:
    /\b(stupid|idiot|dumb|shut up|hate you|you suck|annoying|ugly|boring|pathetic|loser|go away|leave me alone|ta gueule|t'es nul(le)?|je te déteste|conn(e|ard|asse)|débile|idiote?|casse[- ]toi|tais[- ]toi)\b/i,
  apology: /\b(sorry|i apologi[sz]e|my bad|forgive me|didn't mean|pardon|désolée?|excuse[- ]moi|je m'excuse|pardonne[- ]moi)\b/i,
  sharePersonal:
    /\b(i feel|i've been|i was (so |really )?|my (mom|mother|dad|father|family|job|work|sister|brother|friend|ex|childhood|dream)|when i was|i never told|honestly i|je me sens|j'ai (eu|été)|ma (mère|famille|soeur|sœur|copine)|mon (père|frère|travail|boulot|ex|rêve)|quand j'étais|je n'ai jamais dit)\b/i,
  romanticAdvance:
    /\b(i (really )?like you|i('m| am) (falling|into you)|i have feelings|i love you|i want you|kiss (you|me)|hold (your|my) hand|je t'aime|je te kiffe|tu me plais|j'ai des sentiments|je veux t'embrasser)\b|\*\s*(kisses|embrasse)/i,
  askOut:
    /\b(go out with me|(want|wanna) (to )?go on a date|be my date|date with me|have dinner with me|tu veux sortir avec moi|un rendez-vous|un date avec moi|dîner avec moi)\b/i,
  askRelationship:
    /\b(be my (girlfriend|boyfriend|partner)|be together|official(ly)?|exclusive|in a relationship|sois ma copine|sois mon copain|être ensemble|officiel)\b/i,
  affection: /[❤💕😍🥰]|\b(hug|câlin|i care about you|je tiens à toi|you mean (a lot|so much)|tu comptes)\b/iu,
  humor: /[😂🤣]|\b(haha+|hehe+|lol|lmao|mdr|ptdr|xD)\b/iu,
  rival:
    /\b(my (ex|girlfriend|boyfriend|date|crush)|(a|this) (girl|guy|woman|man) (at|from|i met)|went out with|on a date with|flirted with|mon ex|ma copine|mon copain|un mec|une fille|j'ai rencontré)\b/i,
  person:
    /\b(?:my|mon|ma|mes) (sister|brother|mom|mother|dad|father|friend|best friend|boss|colleague|coworker|roommate|ex|girlfriend|boyfriend|cousin|soeur|sœur|frère|mère|père|ami|amie|meilleure? amie?|patron|collègue|coloc)\b(?:,? (?:named |called |qui s'appelle )?([A-Z][\p{L}'-]+))?/giu,
};

const POSITIVE = /\b(love|great|awesome|happy|glad|thanks|thank you|nice|cool|amazing|wonderful|merci|génial|super|content|heureux|heureuse|cool|j'adore|trop bien)\b/gi;
const NEGATIVE = /\b(sad|tired|angry|upset|bad|awful|terrible|hate|depressed|lonely|stressed|triste|fatigué|fatiguée|énervé|énervée|nul|horrible|seul|seule|stressé|stressée)\b/gi;

export function detectSignals(text: string, opts: { absenceHours?: number } = {}): TurnSignals {
  const t = text.trim();
  const intents: Intent[] = [];
  const hit = (re: RegExp) => {
    re.lastIndex = 0;
    return re.test(t);
  };

  if (hit(P.greeting)) intents.push("greeting");
  if (hit(P.goodbye)) intents.push("goodbye");
  if (hit(P.askRelationship)) intents.push("ask_relationship");
  if (hit(P.askOut)) intents.push("ask_out");
  if (hit(P.romanticAdvance)) intents.push("romantic_advance");
  if (hit(P.insult)) intents.push("insult");
  if (hit(P.apology)) intents.push("apology");
  if (hit(P.compliment)) intents.push("compliment");
  if (hit(P.flirt)) intents.push("flirt");
  if (hit(P.affection)) intents.push("affection");
  if (hit(P.sharePersonal)) intents.push("share_personal");
  if (hit(P.humor)) intents.push("humor");
  const hasAction = /\*[^*]{2,}\*/.test(t);
  if (hasAction) intents.push("roleplay_action");
  const question = /\?\s*$|\?\s|^(what|why|how|when|where|who|do you|are you|can you|would you|est-ce|pourquoi|comment|quand|où|qui|tu (es|fais|veux|aimes))\b/i.test(t);
  if (question) intents.push("question");
  if (!intents.length) intents.push("smalltalk");

  const mentionedPeople: string[] = [];
  P.person.lastIndex = 0;
  for (const m of t.matchAll(P.person)) mentionedPeople.push(m[2] ? `${m[1]} ${m[2]}` : m[1]);

  const pos = (t.match(POSITIVE) ?? []).length;
  const neg = (t.match(NEGATIVE) ?? []).length;
  let sentiment = (pos - neg) * 0.25;
  if (intents.includes("compliment") || intents.includes("affection")) sentiment += 0.4;
  if (intents.includes("flirt") || intents.includes("romantic_advance")) sentiment += 0.25;
  if (intents.includes("insult")) sentiment -= 0.8;
  if (intents.includes("apology")) sentiment += 0.1;
  sentiment = Math.max(-1, Math.min(1, sentiment));

  // Priority order for the single headline intent.
  const order: Intent[] = [
    "insult",
    "ask_relationship",
    "ask_out",
    "romantic_advance",
    "apology",
    "compliment",
    "flirt",
    "affection",
    "share_personal",
    "goodbye",
    "greeting",
    "humor",
    "question",
    "roleplay_action",
    "smalltalk",
  ];
  const intent = order.find((i) => intents.includes(i)) ?? "smalltalk";

  return {
    intent,
    intents,
    sentiment,
    question,
    mentionedPeople,
    rivalMention: hit(P.rival),
    hasAction,
    absenceHours: opts.absenceHours ?? 0,
    wordCount: t ? t.split(/\s+/).length : 0,
  };
}
