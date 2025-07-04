import { Client } from "@langchain/langgraph-sdk";
import { execSync } from "node:child_process";
import { State } from ".";

const argv = process.argv.slice(2);
const CLI = {
  serverStreaming: parseCLIBool("--server-streaming", argv) ?? false,
  clientStreaming: parseCLIBool("--client-streaming", argv) ?? false,
  toolCall: parseCLIBool("--tool-call", argv) ?? false,
  concurrency: parseCLIInt("--concurrency", argv) ?? 20,
  maxRuns: parseCLIInt("--max-runs", argv) ?? 20,
};

console.log(`Running with CLI config: ${JSON.stringify(CLI)}`);
const tasks = [];

for (let i = 0; i < CLI.maxRuns; i++) {
  const assistantId = CLI.serverStreaming ? "streaming" : "non-streaming";

  tasks.push(async () => {
    const lgClient = new Client({
      apiUrl: `http://localhost:2024/`,
    });

    try {
      const thread = await lgClient.threads.create({
        graphId: assistantId,
      });

      console.log(`Created thread ${thread.thread_id}, starting run...`);

      if (CLI.clientStreaming) {
        for await (const chunk of lgClient.runs.stream(
          thread.thread_id,
          assistantId,
          {
            input: {
              toolCall: CLI.toolCall,
              messages: [],
            } satisfies typeof State.State,
            streamResumable: true,
            onDisconnect: "cancel",
            streamMode: "messages",
          }
        )) {
          if (chunk.event === "error") {
            console.error("Error", chunk.data);
          }
        }
      } else {
        await lgClient.runs.wait(thread.thread_id, assistantId, {
          input: {
            toolCall: CLI.toolCall,
            messages: [],
          } satisfies typeof State.State,
          streamResumable: true,
          onDisconnect: "cancel",
        });
      }

      console.log(`Run completed for thread ${thread.thread_id}`);
    } catch (e) {
      console.log("Run failed:");
      console.error(e);
    }
  });
}

const aborter = new AbortController();
const cpuMonitor = monitorCPU(aborter);
await parallel(tasks, CLI.concurrency)();
aborter.abort();
console.log(await cpuMonitor);

process.on("uncaughtException", () => {
  aborter.abort();
});

process.on("unhandledRejection", () => {
  aborter.abort();
});

async function monitorCPU(aborter: AbortController) {
  let pid;

  const dbg = [];

  try {
    // find langgraph process based on the name of the graph:
    const lines = execSync('pgrep -f "non-streaming"')
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => Boolean(line));

    dbg.push("pgrep lines", lines);

    // Exclude the watch process...
    const filtered = lines.filter(
      (pid) => !execSync(`ps -p ${pid}`).toString().includes("watch")
    );

    dbg.push("filtered ps lines", filtered);

    pid = filtered.at(0);
  } catch (err) {
    console.error("Could not find langgraph pid!");
    console.error("Debug Info:", dbg.join("\n"));
    console.error(err);
  }

  if (!pid) {
    console.warn("No langgraph pid found, cannot monitor CPU");
    return;
  } else {
    console.log(`Found langgraph pid ${pid}, monitoring!`);
  }

  const result = {
    pid,
    minCpu: 0,
    maxCpu: 0,
    avgCpu: 0,
    p95Cpu: 0,
    minRss: 0,
    maxRss: 0,
    startTimeMs: Date.now(),
    endTimeMs: Date.now(),
    durationMs: 0,
  };

  const cpus = [];

  let firstTick = true;

  while (true) {
    if (aborter.signal.aborted) break;
    // ="" causes no header to be emitted
    const stats = execSync(`ps -p ${pid} -o pid="",%cpu="",rss=""`).toString();
    // console.log(`Stats: ${stats}`);
    const parts = stats.split(/\s+/).filter((s) => Boolean(s.trim()));
    // console.log("parts", parts);
    const cpu = parseFloat(parts[1] ?? "0");
    const rss = parseInt(parts[2] ?? "0");
    result.minCpu = firstTick ? cpu : Math.min(result.minCpu, cpu);
    result.maxCpu = Math.max(result.maxCpu, cpu);
    result.minRss = firstTick ? rss : Math.min(result.minRss, rss);
    result.maxRss = Math.max(result.maxRss, rss);
    cpus.push(cpu);
    firstTick = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  result.endTimeMs = Date.now();
  result.durationMs = result.endTimeMs - result.startTimeMs;
  result.avgCpu = cpus.reduce((a, b) => a + b, 0) / cpus.length;
  result.p95Cpu =
    cpus.sort((a, b) => a - b)[Math.floor(cpus.length * 0.95)] ?? 0;
  return result;
}

function parseCLIBool(flag: string, argv: string[]) {
  const idx = argv.indexOf(flag);
  return idx > -1;
}

function parseCLIInt(flag: string, argv: string[]) {
  const idx = argv.indexOf(flag);
  const next = argv[idx + 1];
  return idx > -1 && next ? parseInt(next) : undefined;
}

/**
 * Runs an initial batch of `Math.max(maxConcurrency, executors.length)` and
 * then adds more as individual members of the batch complete, up to max
 * concurrency. Collects the results.
 */
function parallel<Args, Ret>(
  executors: ((...args: Args[]) => Promise<Ret>)[],
  maxConcurrency = 10
) {
  return async (...args: Args[]) => {
    const results: Awaited<Ret>[] = [];
    const remaining = executors.slice();
    const running = new Set<Promise<Ret>>();

    while (remaining.length > 0 || running.size > 0) {
      while (remaining.length > 0 && running.size < maxConcurrency) {
        const evaluator = remaining.shift();
        if (!evaluator) continue;
        const p = evaluator(...args);
        running.add(p);
        p.finally(() => running.delete(p));
      }

      const winner = await Promise.race(running);
      if (Array.isArray(winner)) {
        results.push(...winner);
      } else {
        results.push(winner);
      }
    }

    return results;
  };
}
