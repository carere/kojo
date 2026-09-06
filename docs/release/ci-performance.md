# CLI integration CI timing

The [baseline CI run](https://github.com/carere/kojo/actions/runs/34048353379) spent 526.18 seconds
in CLI integration tests: 52 files and 236 tests. The [next run](https://github.com/carere/kojo/actions/runs/34049662169)
took 357.79 seconds for the same tier. Both failed the same registration fixture assertion. The tier ran all files in sequence. One Project
registration fixture failed because Runtime resolution used an ambient package cache.

The verbose log attributes most test time to these files. These are sums of named test durations;
they exclude import and cleanup overhead and can overlap within a file.

| File | Test time |
| --- | ---: |
| `runApi.test.ts` | 145.9 s |
| `resourceDaemon.test.ts` | 99.5 s |
| `gateAndResume.test.ts` | 82.8 s |
| `cliContract.test.ts` | 75.5 s |
| `runnerRecovery.test.ts` | 39.0 s |
| `retainedPackages.test.ts` | 28.1 s |

Focused local measurements show why reducing assertion timeouts is not a useful fix. Historical
Workflow switching took 8.7 seconds: 3.3 seconds for three distinct Revision captures, 4.3 seconds
for dispatch and checkpoint restoration, and 0.9 seconds for cleanup. Retry exhaustion took 35.1
seconds and includes the real 1, 2, 4, 8, and 16 second acknowledgement backoffs. These assertions
remain intact. Runtime capture tests took 7.3 seconds locally, compared with 28.1 seconds of named
test time on the CI Host; local wall time is not a CI speed measurement.

Vitest's default four-shard assignment put three expensive files together. The measured test-time
estimates were 74, 330, 27, and 84 seconds. Eight default shards reduced the longest estimate to
154 seconds, before Host setup and cleanup. CI and Release checks now share the same eight-shard
workflow. Each Host still runs one file at a time. Core CI checks run alongside the shards. The
required `Test` status waits for all jobs and fails if any required job fails or is skipped.

The registration fixture now links the workspace Runtime and checks both invalid Factory state
and completed Refresh. This fixes the observed failure; its local duration did not materially
change (2.39 seconds before, 2.35 seconds after).
