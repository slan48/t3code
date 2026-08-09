/**
 * One non-agent smoke test against a real Peer Loop build.
 *
 * It exists to prove the thing a fake cannot: that the argv this server
 * constructs, the handshake it expects, and the schemas it decodes with all
 * match the actual `peer-loop bridge --stdio`.
 *
 * DELIBERATELY LIMITED TO `health` AND `runs.list`. Both are read-only. It does
 * not start, resume, recover or message a run, so it invokes no agent, spends
 * no subscription capacity, and touches no credentials. It reads Peer Loop's
 * own home only through Peer Loop, never directly.
 *
 * Skipped unless `T3_PEER_LOOP_SMOKE_ENTRY` names a built `dist/cli/main.js`,
 * so CI and every machine without a Peer Loop checkout is unaffected.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";

import { PEER_LOOP_NODE_ENTRY_ENV } from "./Command.ts";
import { make } from "./Service.ts";

const smokeEntry = process.env["T3_PEER_LOOP_SMOKE_ENTRY"];
const hasBuild = smokeEntry !== undefined && smokeEntry.trim().length > 0;

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "peer-loop-smoke" });

it.layer(Layer.provideMerge(testConfig, NodeServices.layer), { excludeTestServices: true })(
  "Peer Loop smoke (real build)",
  (it) => {
    it.effect.skipIf(!hasBuild)("handshakes and lists runs against the real bridge", () =>
      Effect.gen(function* () {
        process.env[PEER_LOOP_NODE_ENTRY_ENV] = smokeEntry as string;
        const scope = yield* Scope.make();
        const service = yield* make().pipe(Scope.provide(scope));

        const status = yield* service.status({});
        assert.isTrue(status.configured);
        assert.strictEqual(status.executableSource, "env-node-entry");
        assert.strictEqual(status.transport.state, "connected");
        assert.strictEqual(status.health?.protocolVersion, 1);
        assert.include(status.health?.methods ?? [], "run.recover");
        // Peer Loop states plainly that a run another process drives can be read
        // here but never controlled here. Worth asserting, not assuming.
        assert.strictEqual(status.health?.capabilities["crossProcessControl"], false);

        const runs = yield* service.listRuns({});
        assert.isArray(runs.runs);
        assert.isArray(runs.unreadable);

        yield* Scope.close(scope, Exit.void);
      }),
    );
  },
);
