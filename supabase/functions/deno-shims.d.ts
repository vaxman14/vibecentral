// Minimal Deno ambient types so `tsc -p supabase/functions/tsconfig.json` can check the Edge Function
// without Deno installed. Deno itself ignores this file (it has its own lib).

declare module 'npm:@supabase/supabase-js@2' {
  export * from '@supabase/supabase-js';
}

declare namespace Deno {
  interface Env {
    get(key: string): string | undefined;
    has(key: string): boolean;
  }
  const env: Env;

  interface ServeHandlerInfo {
    remoteAddr: { hostname: string; port: number; transport: string };
  }
  interface HttpServer {
    finished: Promise<void>;
    shutdown(): Promise<void>;
  }
  function serve(handler: (request: Request, info: ServeHandlerInfo) => Response | Promise<Response>): HttpServer;
}
