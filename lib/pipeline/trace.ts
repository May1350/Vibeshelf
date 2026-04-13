export interface SpanContext {
  traceId: string;
  end(): void;
  recordException(err: unknown): void;
}

export function startSpan(_name: string, _attributes?: Record<string, string>): SpanContext {
  const traceId = crypto.randomUUID();
  return {
    traceId,
    end() {
      /* Foundation stub */
    },
    recordException(_err: unknown) {
      /* Foundation stub */
    },
  };
}
