---
name: remembering-conversations
description: Use when past agent conversations may contain decisions, rationale, solutions, or context needed for the current request, or before claiming a topic was never discussed.
---

# Remembering Conversations

Episodic Memory retrieves source-linked historical conversations. It is a recall aid, not a session, task, policy, or current-state authority.

## Recall procedure

1. Find the `episodic-memory` MCP server exposed by the current agent. Tool names may be prefixed by the host; select that server's `search` and `read` tools by their descriptions and schemas rather than assuming one host-specific name.
2. Search for the user's topic or the decision to recover. Use a narrow query and a bounded result limit. For primary-thread evidence only, set `include_sidechains` to `false`.
3. Read only the relevant 2-5 results or line ranges, not entire large transcripts by default. Cite the returned source path and line range when explaining what was said.
4. Separate historical claims from current facts. Recheck the live repository, service, issue, or session owner before an effectful action or present-tense completion claim.

Do not import, summarize, repair, unarchive, or recreate a conversation merely to improve recall. Respect intentional deletions and record exclusions. If the tools are unavailable, state that historical retrieval was not verified; do not invent a conversation or treat another memory layer as a verbatim transcript.

For parameter details, read [MCP-TOOLS.md](MCP-TOOLS.md).
