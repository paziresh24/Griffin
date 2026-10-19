// ask_owner card extras: an MCP server's sign-in link (Claude Code elicitation).
export function askLink(args) {
  const link = typeof args?.link === "string" ? args.link.trim() : "";
  return /^https?:\/\//i.test(link) ? link : null;
}
