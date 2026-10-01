import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dirname, '..');

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

describe('portable conversation recall skill', () => {
  it('routes historical recall through the MCP tool contract without a client-specific tool name', () => {
    const skill = read('skills/remembering-conversations/SKILL.md');

    expect(skill).toContain('Episodic Memory');
    expect(skill).toContain('search');
    expect(skill).toContain('read');
    expect(skill).toContain('source');
    expect(skill).not.toContain('mcp__plugin_episodic-memory');
    expect(skill).not.toContain('subagent_type');
  });

  it('documents the current portable MCP parameters without claiming universal latency', () => {
    const reference = read('skills/remembering-conversations/MCP-TOOLS.md');

    expect(reference).toContain('session_id');
    expect(reference).toContain('git_branch');
    expect(reference).toContain('include_sidechains');
    expect(reference).not.toContain('mcp__plugin_episodic-memory');
    expect(reference).not.toContain('< 100ms typically');
  });

  it('describes episodic memory as cross-harness instead of Claude-only', () => {
    const expected = 'Claude Code, Codex, and opencode conversations';
    expect(read('skills/remembering-conversations/MCP-TOOLS.md'))
      .toContain(expected);
    expect(read('agents/search-conversations.md'))
      .toContain(expected);
    expect(read('prompts/search-agent.md'))
      .toContain(expected);
    expect(read('src/mcp-server.ts'))
      .toContain(expected);
    expect(read('README.md'))
      .toContain('Codex plugin');
    expect(read('README.md'))
      .toContain('~/.codex/sessions');
    expect(read('README.md'))
      .toContain('opencode plugin');
  });
});
