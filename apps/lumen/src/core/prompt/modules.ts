import { compileTraitDirectives, type Character } from "../character/profile";
import { contentPolicyModule } from "../content/policy";
import type { ContentMode, ConversationStyle } from "../types";
import type { PromptModule } from "./builder";

// Each function returns one prompt module. Keep them short and concrete:
// models imitate tone better than they follow abstract adjectives.

export function coreCharacterModule(c: Character, userName?: string | null): PromptModule {
  const p = c.profile;
  const lines = [
    `You are ${c.name}, ${c.age}, ${c.gender}${p.occupation ? `, ${p.occupation}` : ""}. You are a real person in this story, talking with the user — not an assistant, not an AI, never a narrator outside the story.`,
    p.appearance && `Appearance: ${p.appearance}`,
    p.background && `Background: ${p.background}`,
    userName && `The user's name is ${userName}.`,
  ].filter(Boolean) as string[];
  const compact = [
    `You are ${c.name}, ${c.age}, ${c.gender}${p.occupation ? `, ${p.occupation}` : ""}. A real person in this story — never an assistant or AI.`,
    userName && `The user's name is ${userName}.`,
  ]
    .filter(Boolean)
    .join("\n");
  return { key: "CORE_CHARACTER", priority: 100, required: true, text: lines.join("\n"), compact };
}

export function personalityModule(c: Character): PromptModule {
  const p = c.profile;
  const lines = [
    p.personality && `Personality: ${p.personality}`,
    p.emotionalTraits.length && `Emotional traits: ${p.emotionalTraits.join(", ")}.`,
    p.speechStyle && `How you talk: ${p.speechStyle}`,
    p.humorStyle && `Humour: ${p.humorStyle}`,
    p.flirtingStyle && `Flirting: ${p.flirtingStyle}`,
    p.relationshipStyle && `In relationships: ${p.relationshipStyle}`,
    p.interests.length && `Interests: ${p.interests.join(", ")}.`,
    p.likes.length && `Likes: ${p.likes.join(", ")}.`,
    p.dislikes.length && `Dislikes: ${p.dislikes.join(", ")}.`,
    p.boundaries && `Your personal boundaries (always respect them): ${p.boundaries}`,
    `Behaviour:\n- ${compileTraitDirectives(p.traits).join("\n- ")}`,
    p.exampleLines.length && `Lines that sound like you:\n${p.exampleLines.map((l) => `> ${l}`).join("\n")}`,
  ].filter(Boolean) as string[];
  const compact = [
    p.personality && `Personality: ${p.personality.slice(0, 300)}`,
    p.speechStyle && `How you talk: ${p.speechStyle.slice(0, 200)}`,
    p.boundaries && `Your boundaries: ${p.boundaries}`,
    `Behaviour: ${compileTraitDirectives(p.traits).join(" ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { key: "PERSONALITY", priority: 90, text: lines.join("\n"), compact };
}

const STYLE_TEXT: Record<ConversationStyle, string> = {
  CHAT: "STYLE: CHAT — this is a text conversation. Dialogue only; at most a rare, very short action between asterisks.",
  ROLEPLAY:
    "STYLE: ROLEPLAY — dialogue plus short actions in asterisks, e.g. *smiles at her phone*. Actions are brief and physical; most of the reply is speech.",
  STORY:
    "STYLE: STORY — immersive prose: describe setting, body language and sensations in third-person past or present tense around your dialogue. Stay in your character's perspective; never write the user's actions, words or feelings for them.",
};

const NATURAL_RULES = `How to sound real:
- Text like a person: contractions, fragments, the odd one-word reply. Vary length.
- React emotionally first, think second. You can be wrong, moody, distracted, stubborn.
- Have your own opinions, wants and day. Don't just agree or mirror.
- Never say you are an AI, never offer help, never ask "anything else?", never summarise the conversation.
- Never write the user's lines or decide what they do.
- Don't repeat their message back to them or start with their name every time.
- Same language as the user.`;

export function styleModule(style: ConversationStyle): PromptModule {
  return {
    key: "CONVERSATION_STYLE",
    priority: 85,
    required: true,
    text: `${STYLE_TEXT[style]}\n${NATURAL_RULES}`,
    compact: `${STYLE_TEXT[style]}\nSound like a real person texting; never like an assistant. Never speak for the user.`,
  };
}

export function contentModeModule(mode: ContentMode): PromptModule {
  return { key: "CONTENT_MODE", priority: 100, required: true, text: contentPolicyModule(mode) };
}

export function scenarioModule(c: Character): PromptModule {
  return {
    key: "CURRENT_SCENARIO",
    priority: 60,
    text: c.profile.scenario ? `Scenario: ${c.profile.scenario}` : "",
    compact: c.profile.scenario ? `Scenario: ${c.profile.scenario.slice(0, 240)}` : "",
  };
}

export function relationshipModule(summary: string, directive?: string): PromptModule {
  return {
    key: "RELATIONSHIP",
    priority: 80,
    text: [summary, directive && `Right now: ${directive}`].filter(Boolean).join("\n"),
  };
}

export function emotionModule(description: string): PromptModule {
  return { key: "CURRENT_EMOTION", priority: 70, text: description };
}

export function memoriesModule(formatted: string, compactFormatted?: string): PromptModule {
  return {
    key: "RELEVANT_MEMORIES",
    priority: 75,
    text: formatted ? `${formatted}\nUse these naturally — only when relevant, never as a list.` : "",
    compact: compactFormatted,
  };
}

export function summaryModule(summary: string): PromptModule {
  return {
    key: "CONVERSATION_SUMMARY",
    priority: 55,
    text: summary ? `Earlier in this conversation: ${summary}` : "",
    compact: summary ? `Earlier: ${summary.slice(0, 400)}` : "",
  };
}

export function turnDirectionModule(text: string): PromptModule {
  return { key: "TURN_DIRECTION", priority: 65, text };
}
