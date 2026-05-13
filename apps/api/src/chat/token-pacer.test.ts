import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenPacer } from "./token-pacer";

/**
 * The pacer is timing-sensitive; tests use real `setTimeout` calls
 * with comfortable margins (>= 50 ms) so they're not flaky on slow
 * CI runners. None of the assertions check exact timing — only
 * monotonic ordering, total emitted text, and pass-through vs
 * burst-spread behaviour.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("pass-through: tokens slower than minIntervalMs are emitted on each push", async () => {
  const emitted: string[] = [];
  const pacer = new TokenPacer((_, c) => emitted.push(c), 20);

  pacer.push("n", "alpha ");
  await sleep(60);
  pacer.push("n", "beta ");
  await sleep(60);
  pacer.push("n", "gamma");
  pacer.drainAll();
  pacer.dispose();

  // Each push happened far enough apart that the pacer emitted
  // immediately. The exact split between word boundaries doesn't
  // matter for this test — what matters is that everything came out.
  assert.equal(emitted.join(""), "alpha beta gamma");
  assert.ok(emitted.length >= 3, `expected >=3 emissions, got ${emitted.length}`);
});

test("burst-spread: many tokens within minIntervalMs are spread one-word-per-tick", async () => {
  const emitted: { at: number; text: string }[] = [];
  const start = Date.now();
  const pacer = new TokenPacer(
    (_, c) => emitted.push({ at: Date.now() - start, text: c }),
    40,
  );

  // Fire 5 tokens "instantaneously". The pacer should NOT emit them
  // all in the same JS turn — at most the first goes out immediately.
  pacer.push("n", "one ");
  pacer.push("n", "two ");
  pacer.push("n", "three ");
  pacer.push("n", "four ");
  pacer.push("n", "five");

  // Wait long enough for all 5 to flush at 40ms cadence (5 * 40 = 200ms).
  await sleep(400);
  pacer.drainAll();
  pacer.dispose();

  assert.equal(emitted.map((e) => e.text).join(""), "one two three four five");
  // The first emission must happen at or near t=0 (passthrough),
  // and subsequent emissions must be at least ~30 ms apart (allowing
  // for timer jitter — strict >=40ms is too tight for CI).
  for (let i = 1; i < emitted.length; i++) {
    const gap = emitted[i].at - emitted[i - 1].at;
    assert.ok(
      gap >= 30,
      `emission ${i} only ${gap}ms after previous (expected >=30ms)`,
    );
  }
});

test("drain(node) flushes the buffer synchronously", async () => {
  const emitted: string[] = [];
  const pacer = new TokenPacer((_, c) => emitted.push(c), 100);

  pacer.push("n", "first ");
  pacer.push("n", "second ");
  pacer.push("n", "third");

  // Without drain, only the first word would be emitted before our
  // timer-driven flush. Drain must synchronously flush the rest.
  await sleep(20); // let the first emission happen via the immediate path
  pacer.drain("n");
  pacer.dispose();

  assert.equal(emitted.join(""), "first second third");
});

test("drainSmooth(node) spreads the buffered tail instead of one giant chunk", async () => {
  const emitted: { at: number; text: string }[] = [];
  const start = Date.now();
  const pacer = new TokenPacer(
    (_, c) => emitted.push({ at: Date.now() - start, text: c }),
    40,
  );

  pacer.push("n", "first ");
  pacer.push("n", "second ");
  pacer.push("n", "third ");
  pacer.push("n", "fourth");

  await sleep(10);
  await pacer.drainSmooth("n");
  pacer.dispose();

  assert.equal(emitted.map((e) => e.text).join(""), "first second third fourth");
  assert.ok(
    emitted.length >= 4,
    `expected word-sized emissions, got ${JSON.stringify(emitted)}`,
  );
  for (let i = 1; i < emitted.length; i++) {
    const gap = emitted[i].at - emitted[i - 1].at;
    assert.ok(
      gap >= 30,
      `emission ${i} only ${gap}ms after previous (expected >=30ms)`,
    );
  }
});

test("per-node isolation: two nodes don't interfere", async () => {
  const aOut: string[] = [];
  const bOut: string[] = [];
  const pacer = new TokenPacer(
    (n, c) => (n === "a" ? aOut : bOut).push(c),
    20,
  );

  pacer.push("a", "alpha ");
  pacer.push("b", "bravo ");
  pacer.push("a", "again ");
  pacer.push("b", "boom");
  await sleep(200);
  pacer.drainAll();
  pacer.dispose();

  assert.equal(aOut.join(""), "alpha again ");
  assert.equal(bOut.join(""), "bravo boom");
});

test("disabled pacer (interval=0) emits every push synchronously", () => {
  const emitted: string[] = [];
  const pacer = new TokenPacer((_, c) => emitted.push(c), 0);

  pacer.push("n", "alpha");
  pacer.push("n", "beta");
  pacer.push("n", "gamma");
  pacer.dispose();

  // Each push was emitted immediately, so we should have exactly 3
  // emissions in order.
  assert.deepEqual(emitted, ["alpha", "beta", "gamma"]);
});

test("dispose clears pending timers and stops further emissions", async () => {
  const emitted: string[] = [];
  const pacer = new TokenPacer((_, c) => emitted.push(c), 50);

  pacer.push("n", "first ");
  pacer.push("n", "second ");
  pacer.push("n", "third");
  // Dispose before the timer fires; everything queued should be dropped.
  pacer.dispose();
  await sleep(200);

  // Only the synchronous first-emission (if any) survives. The pacer
  // emits its first chunk immediately on push if no prior emit
  // happened, so we tolerate at most one entry here.
  assert.ok(
    emitted.length <= 1,
    `expected <=1 emission after dispose, got ${emitted.length}: ${JSON.stringify(emitted)}`,
  );
});

test("no-whitespace burst: splits long runs at maxChunkChars", async () => {
  const emitted: string[] = [];
  const pacer = new TokenPacer((_, c) => emitted.push(c), 30, 4);

  pacer.push("n", "abcdefghij");
  await pacer.drainSmooth("n");
  pacer.dispose();

  assert.equal(emitted.join(""), "abcdefghij");
  assert.deepEqual(emitted, ["abcd", "efgh", "ij"]);
});
