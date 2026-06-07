import { sleep } from "./helpers.js";
import { logger } from "./logger.js";

type SellTask = () => Promise<boolean>;

interface QueueItem {
  task: SellTask;
  resolve: (value: boolean) => void;
}

const queue: QueueItem[] = [];
let running = false;

async function processQueue(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      const result = await item.task();
      item.resolve(result);
    } catch (err) {
      logger.error(`[SELL QUEUE] task error: ${err}`);
      item.resolve(false);
    }
    if (queue.length > 0) {
      logger.info(`[SELL QUEUE] throttle: 2s before next sell (${queue.length} remaining)`);
      await sleep(2_000);
    }
  }
  running = false;
}

/**
 * Enqueue a sell operation.
 * Sells execute one at a time with a 2-second gap between each
 * to avoid Jupiter 429 rate-limit errors when multiple positions
 * hit TP/SL simultaneously.
 */
export function enqueueSell(task: SellTask): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push({ task, resolve });
    const ahead = queue.length - 1 + (running ? 1 : 0);
    if (ahead > 0) {
      logger.info(`[SELL QUEUE] sell enqueued — ${ahead} sell(s) ahead`);
    }
    processQueue().catch((err) =>
      logger.error(`[SELL QUEUE] processQueue crashed: ${err}`)
    );
  });
}
