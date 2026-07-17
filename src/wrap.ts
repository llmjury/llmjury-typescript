/**
 * Setup-once interception: wrap a provider client and call it directly (OkHttp-interceptor style).
 *
 * ```ts
 * const llm = client.wrap(openaiClient, 'checkout-copy');       // once, at startup
 *
 * await client.withUser(userId, async () => {                   // once per request (middleware)
 *   const response = await llm.chat.completions.create({ model, messages });
 * });
 * ```
 *
 * Every call through the wrapper is timed; calls that look like model invocations (their argument
 * carries `messages`/`prompt`/`model`, or their result exposes token usage) are recorded as an
 * exposure + `model_call` with latency, tokens, model, and `metadata.error` on failures — exactly
 * like `interceptModelCall`, with zero call-site code. Non-model calls pass through untracked, and
 * without an ambient user the call passes through untouched.
 *
 * The wrapper is a duck-typed Proxy: it works with OpenAI- and Anthropic-style clients (or anything
 * shaped like them) without importing any provider SDK.
 */
import { ModelCall, extractResponseFields } from './intercept.js';

/** The `track` half of the client the wrapper needs (avoids a circular import). */
export interface WrapHost {
  currentUser(): string | null;
  track(event: string, payload: Record<string, unknown>): void;
  assign(experiment: string, user: string): string | null;
}

const MODEL_CALL_KEYS = ['messages', 'prompt', 'model', 'input'] as const;

function promptFromArgs(args: unknown[]): string | undefined {
  const options = args[0];
  if (options === null || typeof options !== 'object') return undefined;
  const o = options as Record<string, unknown>;
  const messages = o.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const content = (messages[messages.length - 1] as Record<string, unknown>)?.content;
    if (typeof content === 'string') return content;
  }
  for (const key of ['prompt', 'input']) {
    if (typeof o[key] === 'string') return o[key] as string;
  }
  return undefined;
}

function modelShapedArgs(args: unknown[]): boolean {
  const options = args[0];
  if (options === null || typeof options !== 'object') return false;
  return MODEL_CALL_KEYS.some((key) => key in (options as Record<string, unknown>));
}

function argModel(args: unknown[]): string | undefined {
  const options = args[0] as Record<string, unknown> | undefined;
  return options && typeof options.model === 'string' ? options.model : undefined;
}

function finishModelCall(call: ModelCall, args: unknown[], result: unknown, failed: boolean): void {
  const fields = extractResponseFields(result);
  // Model-shaped args OR token usage on the result. A bare string result is NOT enough on its
  // own — plenty of non-model methods return strings.
  const isModelCall =
    modelShapedArgs(args) ||
    fields.tokens_input !== undefined ||
    fields.tokens_output !== undefined;
  if (!isModelCall) return;
  call.record(failed ? undefined : result, {
    prompt: promptFromArgs(args),
    model: fields.model ?? argModel(args),
  });
  call.finish(failed);
}

function wrapFunction(fn: (...a: unknown[]) => unknown, host: WrapHost, experiment: string) {
  return function intercepted(this: unknown, ...args: unknown[]): unknown {
    const user = host.currentUser();
    if (user === null) return fn.apply(this, args); // nobody to attribute to — pass through
    const variant = host.assign(experiment, user);
    const call = new ModelCall((e, p) => host.track(e, p), experiment, user, variant);
    let result: unknown;
    try {
      result = fn.apply(this, args);
    } catch (err) {
      finishModelCall(call, args, undefined, true);
      throw err;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          finishModelCall(call, args, value, false);
          return value;
        },
        (err) => {
          finishModelCall(call, args, undefined, true);
          throw err;
        },
      );
    }
    finishModelCall(call, args, result, false);
    return result;
  };
}

/** Wrap a provider client so model-shaped calls are traced transparently. */
export function wrapClient<T extends object>(target: T, host: WrapHost, experiment: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value === 'function') {
        return wrapFunction(value.bind(obj) as (...a: unknown[]) => unknown, host, experiment);
      }
      if (value !== null && typeof value === 'object') {
        // Namespace objects (client.chat, client.messages, …) stay wrapped so leaf calls trace.
        return wrapClient(value as object, host, experiment);
      }
      return value;
    },
  }) as T;
}
