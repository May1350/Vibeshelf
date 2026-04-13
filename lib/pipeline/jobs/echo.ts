import type { JobContext } from "@/lib/types/jobs";

export interface EchoInput {
  message: string;
}
export interface EchoOutput {
  echoed: string;
  at: string;
}

export async function echoJob(ctx: JobContext, input: EchoInput): Promise<EchoOutput> {
  ctx.metric("echo_count", 1);
  return { echoed: input.message, at: new Date().toISOString() };
}
