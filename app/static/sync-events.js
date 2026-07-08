/* SSE notifikace o importu a synchronizaci */
import { toast } from "./common.js";

export function initEventStream() {
  if (!window.EventSource) return;
  try {
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === "import_done") {
          toast(`Import dokončen: ${msg.points || 0} bodů, ${msg.visits || 0} návštěv`, "success");
          if (typeof window.loadAll === "function") window.loadAll();
        } else if (msg.event === "import_error") {
          toast("Import selhal: " + (msg.error || ""), "error");
        }
      } catch (_) { /* — */ }
    };
    es.onerror = () => { /* tichý reconnect EventSource */ };
  } catch (_) { /* — */ }
}
