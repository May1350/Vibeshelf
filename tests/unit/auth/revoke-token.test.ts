// tests/unit/auth/revoke-token.test.ts
// Unit test for withTokenRevocationOn401 — verifies the 401 → revoke
// + log path and the 200 → passthrough path. No real network or DB.

import { describe, expect, it, vi } from "vitest";
import { withTokenRevocationOn401 } from "@/lib/auth/revoke-token";

describe("withTokenRevocationOn401", () => {
  it("calls mark_oauth_token_revoked on 401", async () => {
    const rpcMock = vi.fn().mockResolvedValue({ error: null });
    const db = { rpc: rpcMock } as any;
    const fn = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    await withTokenRevocationOn401(fn, { db, userId: "u1", token: "t" });
    expect(rpcMock).toHaveBeenCalledWith("mark_oauth_token_revoked", {
      p_user_id: "u1",
    });
  });

  it("does NOT revoke on 200", async () => {
    const rpcMock = vi.fn();
    const db = { rpc: rpcMock } as any;
    const fn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await withTokenRevocationOn401(fn, { db, userId: "u1", token: "t" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("passes through the fetch response unchanged", async () => {
    const res = new Response("ok", { status: 200 });
    const fn = vi.fn().mockResolvedValue(res);
    const db = { rpc: vi.fn() } as any;
    const got = await withTokenRevocationOn401(fn, {
      db,
      userId: "u1",
      token: "t",
    });
    expect(got).toBe(res);
  });
});
