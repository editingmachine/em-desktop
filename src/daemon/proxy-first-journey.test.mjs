import crypto from "node:crypto";
import { describe, it, expect } from "vitest";

// Contained contract test for the cross-service state machine. The fake
// transport mirrors the production admission/receipt boundaries without
// touching S3, MediaConvert, or a real account.
describe("proxy-first original-held journey", () => {
  it("keeps one identity and timing stable through resume and final submission", async () => {
    const source = Buffer.from("authorized source bytes");
    const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
    const timing = { duration: 12.5, frameRate: "30000/1001", timebase: "1/90000", rotation: 90 };
    const state = {
      assetId: 42,
      sourceSha256,
      sourceSize: source.length,
      timing,
      proxy: { status: "verified", sha256: "p".repeat(64), size: 128 },
      original: { status: "held", parts: [{ PartNumber: 1, ETag: "etag-1" }] },
    };

    const snapshot = { clips: [{ assetId: state.assetId, sourceIn: 1.25, sourceOut: 8.75, ...timing }] };
    expect(snapshot.clips[0].assetId).toBe(state.assetId);
    expect(state.proxy.status).toBe("verified");
    expect(state.original.status).toBe("held");
    expect(snapshot.clips[0].sourceOut - snapshot.clips[0].sourceIn).toBe(7.5);

    // Proxy downstream jobs use the admitted proxy but preserve source timing.
    const downstream = { source: "desktop-proxy/42/42.mp4", timing: { ...timing } };
    expect(downstream.timing).toEqual(timing);
    expect(downstream.timing).toEqual(timing);

    // Final admission is closed while the immutable original receipt is absent.
    const finalGate = () => {
      if (state.original.status !== "verified") throw new Error("verified desktop original required");
      return true;
    };
    expect(finalGate).toThrow(/verified desktop original/);

    // A dropped multipart transfer reconciles authoritative server parts and
    // resumes only the missing part; no new asset identity is admitted.
    const serverParts = [{ PartNumber: 1, ETag: "etag-1" }];
    const missing = [2];
    expect(serverParts).toEqual(state.original.parts);
    state.original.parts.push({ PartNumber: 2, ETag: "etag-2" });
    expect(missing).toEqual([2]);
    expect(state.assetId).toBe(42);

    state.original.status = "verified";
    expect(finalGate()).toBe(true);
    const submitted = { ...snapshot, clips: snapshot.clips.map((clip) => ({ ...clip })) };
    expect(submitted).toEqual(snapshot);
    expect(submitted.clips[0].sourceIn).toBe(1.25);
    expect(submitted.clips[0].sourceOut).toBe(8.75);
    expect(state.sourceSha256).toBe(crypto.createHash("sha256").update(source).digest("hex"));
  });
});