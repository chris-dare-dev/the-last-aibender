/**
 * Fake LM Studio server (plan §3 testkit deliverable: "fake LM Studio
 * /api/v0" — promoted from core/src/adapters/testing/ via ICR-0008, the
 * ICR-0001 path).
 *
 * Real HTTP on 127.0.0.1 (node:http):
 *   - `GET /v1/models` (health probe target);
 *   - `POST /v1/chat/completions` — captures the request (incl. the `ttl`
 *     field the JIT policy rides on), flips the model to `loaded` (JIT
 *     semantics), answers an OpenAI-compatible completion with usage;
 *   - `GET /api/v0/models` — beta state read: per-model `state`,
 *     `quantization`, `max_context_length`;
 *   - down-mid-request simulation: `failNextChat('socket')` destroys the
 *     connection instead of answering (the §9.2 edge case);
 *   - `setModelState` for verified-unload tests (incl. the "unload bypassed,
 *     still loaded" bug shape the verifier exists for).
 *
 * FIXTURE POLICY [X2]: synthesized model keys only.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeLmStudioModel {
  readonly key: string;
  state: 'loaded' | 'not-loaded';
  readonly quantization?: string;
  readonly maxContextLength?: number;
}

export interface RecordedChatRequest {
  readonly model: string;
  readonly ttl?: number;
  readonly maxTokens?: number;
  readonly body: unknown;
}

export interface FakeLmStudioServer {
  readonly url: string;
  readonly port: number;
  addModel(model: FakeLmStudioModel): void;
  setModelState(key: string, state: 'loaded' | 'not-loaded'): void;
  /** Next chat request gets `mode` treatment instead of a completion. */
  failNextChat(mode: 'socket' | 'http-500' | 'model-not-found'): void;
  /** Fixed completion text. Default `synthesized completion`. */
  setCompletionText(text: string): void;
  readonly chatRequests: readonly RecordedChatRequest[];
  close(): Promise<void>;
}

export async function startFakeLmStudioServer(): Promise<FakeLmStudioServer> {
  const models = new Map<string, FakeLmStudioModel>();
  const chatRequests: RecordedChatRequest[] = [];
  let failMode: 'socket' | 'http-500' | 'model-not-found' | undefined;
  let completionText = 'synthesized completion';

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      return undefined;
    }
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '';
      const method = req.method ?? 'GET';

      if (method === 'GET' && url === '/v1/models') {
        json(res, 200, {
          object: 'list',
          data: [...models.keys()].map((id) => ({ id, object: 'model' })),
        });
        return;
      }

      if (method === 'GET' && url === '/api/v0/models') {
        json(res, 200, {
          object: 'list',
          data: [...models.values()].map((model) => ({
            id: model.key,
            object: 'model',
            type: 'llm',
            state: model.state,
            ...(model.quantization !== undefined ? { quantization: model.quantization } : {}),
            ...(model.maxContextLength !== undefined
              ? { max_context_length: model.maxContextLength }
              : {}),
          })),
        });
        return;
      }

      if (method === 'POST' && url === '/v1/chat/completions') {
        const body = await readBody(req);
        const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
          string,
          unknown
        >;
        const model = typeof record['model'] === 'string' ? record['model'] : '';
        chatRequests.push({
          model,
          ...(typeof record['ttl'] === 'number' ? { ttl: record['ttl'] } : {}),
          ...(typeof record['max_tokens'] === 'number' ? { maxTokens: record['max_tokens'] } : {}),
          body,
        });

        if (failMode === 'socket') {
          failMode = undefined;
          res.destroy(); // down mid-request: no HTTP answer at all
          return;
        }
        if (failMode === 'http-500') {
          failMode = undefined;
          json(res, 500, { error: { message: 'synthesized internal failure' } });
          return;
        }
        if (failMode === 'model-not-found' || !models.has(model)) {
          failMode = undefined;
          json(res, 404, { error: { message: `model ${model} not found` } });
          return;
        }

        // JIT: the inference request loads the model.
        const entry = models.get(model);
        if (entry !== undefined) entry.state = 'loaded';
        json(res, 200, {
          id: 'chatcmpl-synth0001',
          object: 'chat.completion',
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: completionText },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
        });
        return;
      }

      json(res, 404, { error: 'not found' });
    })().catch(() => res.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake lmstudio server did not bind a port');
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    addModel: (model) => {
      models.set(model.key, { ...model });
    },
    setModelState: (key, state) => {
      const model = models.get(key);
      if (model !== undefined) model.state = state;
    },
    failNextChat: (mode) => {
      failMode = mode;
    },
    setCompletionText: (text) => {
      completionText = text;
    },
    chatRequests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
