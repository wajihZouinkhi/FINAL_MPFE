import type { UIMessage } from "@ai-sdk/react";
import type { MpfeDataPartShapes } from "@mpfe/shared";

/**
 * Thread-typed UIMessage. v5 lets the app declare its own data-part
 * shapes via the second `UIMessage` generic; we plug in
 * `MpfeDataPartShapes` (the type-only mirror of the runtime `DataPart`
 * union in `@mpfe/shared`) so `useChat`'s `onData(dataPart)` callback
 * typechecks the `data-${kind}` discriminator + the `data` payload
 * against the same 13 typed slices the agent produces. The metadata
 * generic stays at the default `unknown` because the API doesn't
 * attach per-message metadata.
 *
 * Lives in `lib/` rather than next to the chat pane so the thread
 * shells (`view.tsx`, `activity-view.tsx`) and any future callers can
 * type their `initialMessages` arrays against the same alias without
 * pulling in client component code at the type level.
 */
export type MpfeUIMessage = UIMessage<unknown, MpfeDataPartShapes>;

/** Concatenate every text part in a UIMessage into a flat string. */
export function getMessageText(m: MpfeUIMessage): string {
  let out = "";
  for (const part of m.parts) {
    if (part.type === "text") out += part.text;
  }
  return out;
}
