# Episodic Memory MCP Tools Reference

The `episodic-memory` server searches supported Claude Code, Codex, and opencode conversations, as well as other transcript sources admitted by the installed version. MCP hosts may prefix tool names; discover the server's current tool list instead of copying one client's namespace.

## search

Search historical conversations using semantic similarity, exact text, or both.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string or 2-5 strings | Yes | Single concept or multi-concept AND search |
| `mode` | `vector`, `text`, or `both` | No | Default `both`; applies to a single query |
| `limit` | integer 1-50 | No | Default 10 |
| `after`, `before` | `YYYY-MM-DD` | No | Date bounds |
| `project` | string | No | Exact project name |
| `session_id` | string | No | Exact source session ID |
| `git_branch` | string | No | Exact branch name |
| `include_sidechains` | boolean | No | Default true; set false for main threads only |
| `response_format` | `markdown` or `json` | No | Default `markdown` |

Results may include summaries, snippets, scores, source paths, and line numbers. Search ranking is not proof that a result answers the question; use `read` to inspect the relevant source.

## read

Read a source conversation through the same record-admission policy used by search.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | absolute path | Yes | A path returned by search |
| `startLine` | positive integer | No | First physical line, inclusive |
| `endLine` | positive integer | No | Last physical line, inclusive |

Prefer a narrow `startLine`/`endLine` range. Large transcripts can be slow and contain sensitive context. Both tools report input, source, policy, or runtime failures as tool errors; do not turn an error or absent result into a healthy-history conclusion.
