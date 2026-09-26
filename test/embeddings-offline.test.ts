import { describe, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  env: { allowLocalModels: false, allowRemoteModels: true, useBrowserCache: true },
  pipeline: vi.fn(async () => async () => ({ data: new Float32Array(384) })),
}));

import { env, pipeline } from '@huggingface/transformers';
import { initEmbeddings } from '../src/embeddings.js';

describe('embedding model locality', () => {
  it('disables remote model loading before opening the embedding pipeline', async () => {
    await initEmbeddings();
    expect(env.allowLocalModels).toBe(true);
    expect(env.allowRemoteModels).toBe(false);
    expect(pipeline).toHaveBeenCalledOnce();
  });
});
