# langgraph-perf-issue

This slams a local langgraphjs server, maintaining `--concurrency [num]` concurrent runs until reaching a total `--max-runs [num]`.

# Setup

```
pnpm install
pnpm run dev
```

You may want to signal the server via pid to allow profiling via Chrome DevTools:

```
kill -s SIGUSR2 [pid here]
```

# Usage

```
# server streaming uses much more cpu / GC / memory
pnpm run slam --max-runs 20 --server-streaming

# tool call as the output uses more
pnpm run slam --max-runs 20 --server-streaming --tool-call
```

It prints out the current CLI config, a line for each run, and at the end shows the min/max cpu, rss, duration.

# Needs

- [x] measure max memory?
- [x] measure max CPU time?
- [x] measure duration?

- [x] convert to a tool call
- [ ] confirm AIMessageChunk issue by profiling while streaming is running
- [ ] try langgraph 0.3.5

- [ ] Run a streaming graph with N concurrencies to demonstrate AIMessageChunk issue (memory + CPU)
- [ ] Run a non-streaming graph with N concurrencies to demonstrate AIMessageChunk issue (memory + CPU)
- [ ] Run a non-streaming graph with N concurrencies to demonstrate RunTree issue (memory + CPU)
