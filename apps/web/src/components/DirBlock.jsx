import { Block } from "streamdown";
import { textDir } from "../dir.js";

// Each markdown block (paragraph, list, heading, table) takes its own direction from its own text, so an
// English paragraph in a Persian answer sits on the left and a Persian one on the right (owner 2026-10-25).
// A block with no letters (a number, an emoji) keeps the sheet's direction.
export function DirBlock(props) {
  const dir = textDir(props.content);
  return <Block {...props} dir={dir === "auto" ? props.dir : dir} />;
}
