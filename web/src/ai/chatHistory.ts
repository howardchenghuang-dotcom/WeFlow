/**
 * Bounded local AI dialogue. Previous user/assistant turns are conversational context,
 * not privileged instructions. WeChat excerpts are only sent when the user opts in.
 */
import type { AiMessage } from './bridge';

export type AiTurn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  time: number;
  model?: string;
  citations?: { localId: number; createTime: number; sender: string }[];
  truncated?: boolean;
  /** Which messages went with the question, said for the reader. */
  scope?: string;
  /**
   * The period asked for held more than fit: it was read up to `start` (Unix seconds), and goes on to `end`.
   * The reader can have the next turn read on from there.
   */
  rest?: { start: number; end: number };
  /** The answer was stopped, timed out or broke off: what is shown is not all of it. */
  partial?: boolean;
};

export const MAX_VISIBLE_TURNS = 30;
export const MAX_CONTEXT_CHARS = 8_000;
export const MAX_QUESTION = 800;
const MAX_TURN_CHARS = 2_500;

/**
 * The conversation sent to the model: the latest earlier turns in their own roles (at most 8k characters of them),
 * then the question. It never reads any other WeChat conversation, and holds an excerpt only when the caller gives
 * one, which the page does for the turn the reader ticked it for.
 */
export function buildAiMessages(question: string, previous: readonly AiTurn[], excerpt?: string): AiMessage[] {
  const current = question.trim();
  if (!current || current.length > MAX_QUESTION) throw new Error('question is empty or too long');
  const selected: AiMessage[] = [];
  let used = 0;
  for (const turn of previous.slice(-MAX_VISIBLE_TURNS).reverse()) {
    const content = turn.text.slice(0, MAX_TURN_CHARS);
    if (!content.trim()) continue;
    if (used + content.length > MAX_CONTEXT_CHARS) break;
    used += content.length;
    selected.push({ role: turn.role, content });
  }
  selected.reverse();
  // A plain question goes as it was typed. With an excerpt, the question comes last and is marked, so that text
  // quoted from the chat cannot pass for it.
  const last = excerpt ? excerpt + '\n\n--- CURRENT USER QUESTION ---\n' + current : current;
  return [...selected, { role: 'user', content: last }];
}
