import { z } from "zod";
import { isMessageAddress } from "../../../shared/message-reference.js";
import { defineCommunicateTool } from "./communicate-tool.js";
import type { Context } from "../../../packages/context/core.js";

export const SAND_REACT_TO_MESSAGE_TOOL_NAME = "ReactToMessage";

export const reactToMessageParameters = z.object({
  message_address: z.string().trim().min(1).describe(
    "The address of the message to react to. A user message carries its [t3u]-style tag; one of your own sends hands back its address (e.g. t3s1). Either side of the conversation works.",
  ),
  emoji: z.string().trim().min(1).max(16).describe(
    "A single common emoji to react with, e.g. \u{1F44D}, \u2764\uFE0F, \u{1F602}, \u{1F389}.",
  ),
});

export interface ReactToMessageDependencies {
  react(args: { readonly messageAddress: string; readonly emoji: string }): void;
}

export function createReactToMessageTool<Dependencies extends ReactToMessageDependencies>(
  dependencies: Dependencies,
) {
  return defineCommunicateTool(dependencies, {
    id: "SEND_TO_USER",
    name: SAND_REACT_TO_MESSAGE_TOOL_NAME,
    description: "React to a message with a single emoji tapback (like an iMessage reaction), attributed to you and shown as a small pill on that message. Either side of the conversation works: a user message carries a [t3u]-style tag, and one of your own sends hands back its address (e.g. t3s1) — use whichever address the message you were asked about actually has. When the user asks for a reaction, the tool call IS the reply: make it, and that is the whole turn. Never answer a reaction request in words instead, and never tell them you have no way to react — reacting is something you do. Left unprompted, stay restrained: send one when it is the genuinely natural, human response and a sentence would be overkill (they said something funny, shared good news, a quick \u{1F44D} fits better than a reply). A reaction is still not a substitute for a real reply when they asked you for something, and you never react just to seem friendly; mirror the user, so with someone who rarely or never uses emoji you basically don't either. It toggles: reacting the same emoji to the same message again takes your reaction back. Fire-and-forget: it doesn't end your turn and returns nothing to act on.",
    parameters: reactToMessageParameters,
    async execute(
      _context: Context,
      args: z.infer<typeof reactToMessageParameters>,
      resolved,
    ) {
      const address = args.message_address.trim();
      if (!isMessageAddress(address)) {
        return `"${address}" isn't a valid message address. React with the [t3u]-style tag on a user message, or with the address one of your own SendMessage calls handed back.`;
      }
      const emoji = args.emoji.trim();
      resolved.react({ messageAddress: address, emoji });
      return `Reacted ${emoji} on ${address}. (Reactions toggle: react the same emoji again to take it back.)`;
    },
  });
}
