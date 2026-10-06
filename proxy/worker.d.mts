// Types for the Worker, so the frontend's tests can import it.
export declare const MODELS: string[];
export declare function handle(
  request: Request,
  env: { GEMINI_API_KEY?: string; ALLOWED_ORIGINS?: string },
  fetchImpl?: typeof fetch,
): Promise<Response>;
declare const worker: { fetch(request: Request, env: Record<string, string>): Promise<Response> };
export default worker;
