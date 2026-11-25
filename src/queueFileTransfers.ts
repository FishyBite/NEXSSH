import { request } from "./api";
import { message } from "./types";
import type { FileTransferPlan } from "./fileTransferDrag";

export async function queueFileTransfers(
  plan: FileTransferPlan,
  tabId: string,
  notify: (text: string, error?: boolean) => void,
  onQueued?: (id: string) => void,
) {
  let queued = 0;
  const batchId = crypto.randomUUID();
  try {
    for (const payload of plan.requests) {
      const transfer = await request<{ id: string }>("transfer_start", { ...payload, batchId, tabId });
      queued++;
      if (transfer?.id) onQueued?.(transfer.id);
    }
    notify(
      `${queued} transfer${queued === 1 ? "" : "s"} queued for ${plan.sessionName}`,
    );
  } catch (error) {
    notify(
      `${queued ? `${queued} of ${plan.requests.length} transfers queued. ` : ""}${message(error)}`,
      true,
    );
  }
  return queued;
}
