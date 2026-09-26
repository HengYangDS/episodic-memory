import { describe, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  env: { allowLocalModels: false, allowRemoteModels: true, useBrowserCache: true },
  pipeline: vi.fn(async () => async () => ({ data: new Float32Array(384) })),
}));

import { env, pipeline } from '@huggingface/transformers';
import { initEmbeddings } from '../src/embeddings.js';

describe('embedding model locality', () => {
  it('defaults to offline even when no environment override is set', async () => {
    const previous = process.env.EPISODIC_MEMORY_OFFLINE;
    delete process.env.EPISODIC_MEMORY_OFFLINE;
    try {
      await initEmbeddings();
      expect(env.allowLocalModels).toBe(true);
      expect(env.allowRemoteModels).toBe(false);
      expect(pipeline).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.EPISODIC_MEMORY_OFFLINE;
      else process.env.EPISODIC_MEMORY_OFFLINE = previous;
    }
  });
});
