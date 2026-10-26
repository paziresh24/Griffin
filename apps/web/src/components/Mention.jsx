import { mentionSpans } from "@griffin/timeline";

// «@» tags drawn as chips, the way Discord shows a mention (owner 2026-10-21): in a sent message
// (MentionText) and, behind the composer's own text, in the box while typing (ComposerAssist).
export function MentionText({ text, handles = null }) {
  const spans = mentionSpans(text, handles);
  return spans.map((s, i) => (s.tag ? <span key={i} className="g-mention" dir="auto">{s.text}</span> : s.text));
}

/** A user message's text part (MessagePrimitive.Parts' Text) with its tags as chips. */
export function MentionPart({ text }) {
  return <MentionText text={text} />;
}
