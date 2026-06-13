import { getUsageStats, statsEmitter } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null, sendPending: null };

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) statsEmitter.off("update", state.send);
    if (state.sendPending) statsEmitter.off("pending", state.sendPending);
    if (state.keepalive) clearInterval(state.keepalive);
  };

  request?.signal?.addEventListener?.("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      const sendStats = async () => {
        if (state.closed) return;
        try {
          const stats = await getUsageStats();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          cleanup();
        }
      };

      // Pending changes send a full stats snapshot, never a partial merge into stale cache.
      state.send = sendStats;
      state.sendPending = sendStats;

      await state.send();
      if (state.closed) return;

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
