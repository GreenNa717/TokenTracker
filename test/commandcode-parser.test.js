/**
 * Command Code (`cmd`, commandcode.ai) parser test.
 *
 * Command Code persists one JSONL transcript per conversation under
 * `~/.commandcode/projects/<cwd-slug>/<session-id>.jsonl`. The session header
 * carries the launch cwd; each completed assistant turn appends a record whose
 * top-level `model`/`usage` are the CLI's own accounting. `message` sits in the
 * middle of the record, so the reader must slice fields instead of parsing the
 * line — this suite asserts that prompts never reach JSON.parse.
 *
 * This suite covers:
 *   - `resolveCommandCodeHome(s)` precedence and the Windows native/WSL matrix
 *   - `resolveCommandCodeSessionFiles` transcript discovery (checkpoints skipped)
 *   - usage normalization (OpenAI-style cache-inclusive input; billed costUsd)
 *   - rebuild-and-diff reconciliation: rerun no-op, rewritten transcript,
 *     deleted session, and queue-append failures
 *   - the committed fixture's sanitization contract
 *
 * The sample fixture is a real, sanitized transcript (token counts and the
 * provider's billed `costUsd` only — message bodies stripped).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  resolveCommandCodeHome,
  resolveCommandCodeHomes,
  resolveCommandCodeSessionFiles,
  isCommandCodeSessionLogName,
  normalizeCommandCodeModelName,
  commandCodeUsageToTotals,
  extractCommandCodeSessionUsage,
  parseCommandCodeIncremental,
} = require("../src/lib/rollout");

const FIXTURE = path.join(__dirname, "fixtures", "commandcode", "sample-session.jsonl");
const T0 = "2026-05-01T12:00:00.000Z";

function headerLine(id = "sess-1", cwd = "/home/user/project", timestamp = T0) {
  return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd });
}

function messageLine({
  id,
  timestamp = T0,
  inputTokens = 1000,
  outputTokens = 100,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  costUsd = 0.001,
  model = "deepseek/deepseek-v4.1-flash",
  message = null,
} = {}) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: "parent",
    timestamp,
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd },
    model,
    effort: "max",
    message,
  });
}

function makeTree({ slug = "c-users-mechrevo", sessionId = "sess-1", lines = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-test-"));
  const home = path.join(dir, ".commandcode");
  const projectDir = path.join(home, "projects", slug);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return { dir, home, projectDir, filePath };
}

function readRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

function commandCodeRows(queuePath) {
  return readRows(queuePath).filter((row) => row.source === "command-code");
}

// Bucket rows are latest-wins snapshots: a reconciliation that removes usage
// appends a lower (or zero) snapshot for the same (model, hour_start) key
// rather than retracting the earlier row, so consumers read the last row per key.
function latestCommandCodeRows(queuePath) {
  const latest = new Map();
  for (const row of commandCodeRows(queuePath)) {
    latest.set(`${row.model}|${row.hour_start}`, row);
  }
  return latest;
}

function latestCommandCodeTokens(queuePath) {
  return [...latestCommandCodeRows(queuePath).values()]
    .reduce((sum, row) => sum + row.total_tokens, 0);
}

test("resolveCommandCodeHome honors TOKENTRACKER_COMMANDCODE_HOME, then defaults to ~/.commandcode", () => {
  assert.equal(
    resolveCommandCodeHome({ TOKENTRACKER_COMMANDCODE_HOME: "/tmp/cc" }),
    path.resolve("/tmp/cc"),
  );
  assert.equal(resolveCommandCodeHome({ TOKENTRACKER_COMMANDCODE_HOME: "  " }), path.join(os.homedir(), ".commandcode"));
  assert.equal(resolveCommandCodeHome({}), path.join(os.homedir(), ".commandcode"));
});

test("resolveCommandCodeHomes follows the Windows native/WSL mode matrix", () => {
  const nativeHome = "/native/.commandcode";
  const wslHome = "\\\\wsl$\\Ubuntu\\home\\dev\\.commandcode";
  const deps = {
    platform: "win32",
    nativeHome,
    existsSync(candidate) {
      return candidate === nativeHome;
    },
    discoverWslHome(providerDir) {
      assert.equal(providerDir, ".commandcode");
      return wslHome;
    },
  };

  assert.deepEqual(resolveCommandCodeHomes({}, deps), [wslHome], "default is wsl-first");
  assert.deepEqual(resolveCommandCodeHomes({ TOKENTRACKER_WSL_MODE: "native-first" }, deps), [nativeHome]);
  assert.deepEqual(resolveCommandCodeHomes({ TOKENTRACKER_WSL_MODE: "wsl-only" }, deps), [wslHome]);
  assert.deepEqual(resolveCommandCodeHomes({ TOKENTRACKER_WSL_MODE: "native-only" }, deps), [nativeHome]);
  assert.deepEqual(resolveCommandCodeHomes({ TOKENTRACKER_WSL_MODE: "both" }, deps), [nativeHome, wslHome]);
});

test("resolveCommandCodeHomes keeps explicit overrides authoritative and never probes WSL off Windows", () => {
  let probes = 0;
  const overridden = resolveCommandCodeHomes(
    { TOKENTRACKER_COMMANDCODE_HOME: "/custom/.commandcode", TOKENTRACKER_WSL_MODE: "both" },
    {
      platform: "win32",
      discoverWslHome() {
        probes += 1;
        return "\\\\wsl$\\Ubuntu\\home\\dev\\.commandcode";
      },
    },
  );
  assert.deepEqual(overridden, [path.resolve("/custom/.commandcode")]);
  assert.equal(probes, 0, "an explicit home must suppress automatic WSL discovery");

  assert.deepEqual(
    resolveCommandCodeHomes({}, { platform: "darwin", nativeHome: "/Users/dev/.commandcode" }),
    ["/Users/dev/.commandcode"],
  );
});

test("isCommandCodeSessionLogName accepts transcripts and rejects checkpoint snapshots", () => {
  assert.equal(isCommandCodeSessionLogName("277f4e1b-b393-4e85-abd2-3b8f01f81b97.jsonl"), true);
  assert.equal(isCommandCodeSessionLogName("277f4e1b-b393-4e85-abd2-3b8f01f81b97.checkpoints.jsonl"), false);
  assert.equal(isCommandCodeSessionLogName("277f4e1b-b393-4e85-abd2-3b8f01f81b97.meta.json"), false);
  assert.equal(isCommandCodeSessionLogName("notes.txt"), false);
  assert.equal(isCommandCodeSessionLogName(""), false);
  assert.equal(isCommandCodeSessionLogName(null), false);
});

test("resolveCommandCodeSessionFiles discovers project transcripts and skips non-transcript siblings", async () => {
  const { dir, home, projectDir, filePath } = makeTree({
    lines: [headerLine(), messageLine({ id: "m1" })],
  });
  const otherDir = path.join(home, "projects", "c-users-other");
  fs.mkdirSync(otherDir, { recursive: true });
  const otherPath = path.join(otherDir, "other-session.jsonl");
  fs.writeFileSync(otherPath, `${headerLine("sess-2")}\n${messageLine({ id: "m2" })}\n`, "utf8");
  // Siblings that must never be parsed as transcripts.
  fs.writeFileSync(
    path.join(projectDir, "sess-1.checkpoints.jsonl"),
    `${messageLine({ id: "checkpoint" })}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(projectDir, "sess-1.meta.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(home, "projects", "stray.jsonl"), `${messageLine({ id: "stray" })}\n`, "utf8");

  try {
    const files = await resolveCommandCodeSessionFiles({ TOKENTRACKER_COMMANDCODE_HOME: home });
    assert.deepEqual(files, [filePath, otherPath].sort((a, b) => a.localeCompare(b)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("commandCodeUsageToTotals subtracts cache reads from the cache-inclusive input", () => {
  // Values from a real DeepSeek V4.1 Flash turn: the cache read is already part
  // of inputTokens, so storing the column verbatim would double count it.
  assert.deepEqual(commandCodeUsageToTotals({
    inputTokens: 22918,
    outputTokens: 14736,
    cacheReadTokens: 7296,
    cacheWriteTokens: 0,
    costUsd: 0.011206788,
  }), {
    input_tokens: 15622,
    cached_input_tokens: 7296,
    cache_creation_input_tokens: 0,
    output_tokens: 14736,
    reasoning_output_tokens: 0,
    total_tokens: 37654,
    billable_total_tokens: 37654,
    total_cost_usd: 0.011206788,
    conversation_count: 1,
  });

  assert.equal(
    commandCodeUsageToTotals({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    null,
    "all-zero usage is not a billable event",
  );
  assert.equal(commandCodeUsageToTotals(null), null);

  const malformed = commandCodeUsageToTotals({
    inputTokens: -5,
    outputTokens: Number.NaN,
    cacheReadTokens: Infinity,
    cacheWriteTokens: 0,
    costUsd: -1,
  });
  assert.equal(malformed, null, "malformed numbers clamp to zero and drop the record");

  const clamped = commandCodeUsageToTotals({
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 500,
    cacheWriteTokens: 0,
    costUsd: 0,
  });
  assert.equal(clamped.input_tokens, 0, "a cache read exceeding the input cannot go negative");
  assert.equal(clamped.total_tokens, 510);
  assert.equal(clamped.total_cost_usd, 0, "an unreported cost keeps the zero sentinel");
});

test("normalizeCommandCodeModelName strips the provider prefix", () => {
  assert.equal(normalizeCommandCodeModelName("deepseek/deepseek-v4.1-flash"), "deepseek-v4.1-flash");
  assert.equal(normalizeCommandCodeModelName("gpt-6-sol"), "gpt-6-sol");
  assert.equal(normalizeCommandCodeModelName("  "), null);
  assert.equal(normalizeCommandCodeModelName(null), null);
});

test("extractCommandCodeSessionUsage reads header, model and buckets without materializing message bodies", () => {
  const secret = "SECRET_PROMPT_MUST_NOT_BE_PARSED";
  const lines = [
    headerLine("sess-9", "/home/user/project"),
    messageLine({
      id: "m1",
      timestamp: "2026-05-01T12:10:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: secret }] },
    }),
    // All-zero usage carries no billable event.
    messageLine({ id: "m2", timestamp: "2026-05-01T12:20:00.000Z", inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    // A different half-hour and an unqualified model id.
    messageLine({
      id: "m3",
      timestamp: "2026-05-01T12:40:00.000Z",
      model: "gpt-6-sol",
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 100,
      costUsd: 0.002,
    }),
    // Torn tail: a record that never completed must contribute nothing.
    '{"type":"message","id":"m4","timestamp":"2026-05-01T13:0',
  ];

  const originalParse = JSON.parse;
  let leaked = false;
  JSON.parse = function privacyGuard(value, ...rest) {
    if (String(value).includes(secret)) leaked = true;
    return originalParse.call(this, value, ...rest);
  };
  let parsed;
  try {
    parsed = extractCommandCodeSessionUsage(lines.join("\n"));
  } finally {
    JSON.parse = originalParse;
  }
  assert.equal(leaked, false, "message content reached JSON.parse");

  assert.equal(parsed.sessionId, "sess-9");
  assert.equal(parsed.cwd, "/home/user/project");
  assert.equal(parsed.records.length, 2, "zero-usage and torn records are dropped");
  assert.equal(parsed.records[0].bucketStart, "2026-05-01T12:00:00.000Z");
  assert.equal(parsed.records[0].model, "deepseek-v4.1-flash");
  assert.equal(parsed.records[1].bucketStart, "2026-05-01T12:30:00.000Z");
  assert.equal(parsed.records[1].model, "gpt-6-sol");
  assert.equal(parsed.records[1].totals.total_tokens, 550);
});

test("parseCommandCodeIncremental queues the committed fixture, skips unchanged files, and dedups on rerun", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-fixture-"));
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  const first = await parseCommandCodeIncremental({
    sessionFiles: [FIXTURE],
    cursors,
    queuePath,
  });
  assert.equal(first.recordsProcessed, 6, "the fixture carries six usage records");
  assert.equal(first.eventsAggregated, 6);

  const rows = commandCodeRows(queuePath);
  assert.equal(rows.length, 1, "all six turns land in one half-hour bucket");
  assert.equal(rows[0].model, "deepseek-v4.1-flash");
  assert.equal(rows[0].hour_start, "2026-09-23T09:30:00.000Z");
  assert.equal(rows[0].conversation_count, 6);
  assert.equal(rows[0].input_tokens, 22918 - 7296 + 37768 - 7424 + 38950 - 37888 + 55659 - 39168 + 56742 - 56576 + 57818 - 57216);
  assert.equal(rows[0].cached_input_tokens, 7296 + 7424 + 37888 + 39168 + 56576 + 57216);
  assert.equal(rows[0].output_tokens, 14736 + 122 + 232 + 1073 + 587 + 165);
  // The provider-reported bill is authoritative for this source.
  const expectedCost = 0.011206788 + 0.0046470719999999995 + 0.00041216399999999997 + 0.0032349539999999995 + 0.000546828 + 0.000360948;
  assert.ok(Math.abs(rows[0].total_cost_usd - expectedCost) < 1e-12);

  // Second run: (size, mtime) unchanged, so the transcript is not re-read and
  // nothing is re-queued.
  const second = await parseCommandCodeIncremental({
    sessionFiles: [FIXTURE],
    cursors,
    queuePath,
  });
  assert.equal(second.recordsProcessed, 0, "an unchanged file is not re-read");
  assert.equal(second.eventsAggregated, 0);
  assert.equal(second.bucketsQueued, 0);
  assert.equal(commandCodeRows(queuePath).length, 1, "no duplicate bucket rows");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseCommandCodeIncremental reconciles a rewritten transcript (resume/compaction) without double counting", async () => {
  const { dir, filePath } = makeTree({
    lines: [
      headerLine("sess-rewrite"),
      messageLine({ id: "m1", inputTokens: 1000, outputTokens: 100, costUsd: 0.001 }),
      messageLine({ id: "m2", timestamp: "2026-05-01T12:40:00.000Z", inputTokens: 2000, outputTokens: 200, costUsd: 0.002 }),
    ],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  try {
    await parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(latestCommandCodeTokens(queuePath), 1100 + 2200);

    // A resume drops m1's record and adds m3, rewriting the file in place.
    fs.writeFileSync(
      filePath,
      [
        headerLine("sess-rewrite"),
        messageLine({ id: "m2", timestamp: "2026-05-01T12:40:00.000Z", inputTokens: 2000, outputTokens: 200, costUsd: 0.002 }),
        messageLine({ id: "m3", timestamp: "2026-05-01T13:10:00.000Z", inputTokens: 3000, outputTokens: 300, costUsd: 0.003 }),
      ].join("\n") + "\n",
      "utf8",
    );
    await parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath });

    const buckets = latestCommandCodeRows(queuePath);
    // The dropped record's bucket reconciles back to zero instead of being
    // double counted or left behind.
    assertBucket(buckets.get("deepseek-v4.1-flash|2026-05-01T12:00:00.000Z"), 0, 0, 0);
    assertBucket(buckets.get("deepseek-v4.1-flash|2026-05-01T12:30:00.000Z"), 2000, 2200, 0.002);
    assertBucket(buckets.get("deepseek-v4.1-flash|2026-05-01T13:00:00.000Z"), 3000, 3300, 0.003);

    assert.equal(
      latestCommandCodeTokens(queuePath),
      2200 + 3300,
      "every surviving record is counted exactly once",
    );

    const repeat = await parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(repeat.eventsAggregated, 0, "a serialized rerun adds nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function assertBucket(row, inputTokens, totalTokens, cost) {
  assert.ok(row, "bucket exists");
  assert.equal(row.input_tokens, inputTokens);
  assert.equal(row.total_tokens, totalTokens);
  assert.ok(Math.abs(row.total_cost_usd - cost) < 1e-12, `cost ~${cost}, got ${row.total_cost_usd}`);
}

test("parseCommandCodeIncremental drops a deleted session's contribution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-delete-"));
  const home = path.join(dir, ".commandcode");
  const projectDir = path.join(home, "projects", "slug");
  fs.mkdirSync(projectDir, { recursive: true });
  const firstPath = path.join(projectDir, "sess-a.jsonl");
  const secondPath = path.join(projectDir, "sess-b.jsonl");
  fs.writeFileSync(firstPath, `${headerLine("sess-a")}\n${messageLine({ id: "a1", inputTokens: 1000, outputTokens: 100 })}\n`, "utf8");
  fs.writeFileSync(
    secondPath,
    `${headerLine("sess-b")}\n${messageLine({ id: "b1", timestamp: "2026-05-01T12:40:00.000Z", inputTokens: 700, outputTokens: 70 })}\n`,
    "utf8",
  );
  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};

  try {
    await parseCommandCodeIncremental({ sessionFiles: [firstPath, secondPath], cursors, queuePath });
    assert.equal(latestCommandCodeTokens(queuePath), 1100 + 770);

    fs.rmSync(firstPath, { force: true });
    await parseCommandCodeIncremental({ sessionFiles: [secondPath], cursors, queuePath });
    assert.equal(
      latestCommandCodeTokens(queuePath),
      770,
      "a session whose transcript is gone stops contributing",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCommandCodeIncremental does not commit cursor state when queue append fails", async () => {
  const { dir, filePath } = makeTree({
    lines: [headerLine("sess-queue-failure"), messageLine({ id: "m1" })],
  });
  const queuePath = path.join(dir, "queue-as-directory");
  const cursors = {};
  fs.mkdirSync(queuePath);

  try {
    await assert.rejects(
      parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath }),
      /EISDIR|directory/i,
    );
    assert.equal(cursors.hourly, undefined);
    assert.equal(cursors.commandCode, undefined);

    fs.rmSync(queuePath, { recursive: true, force: true });
    const recovered = await parseCommandCodeIncremental({ sessionFiles: [filePath], cursors, queuePath });
    assert.equal(recovered.eventsAggregated, 1);
    const rows = commandCodeRows(queuePath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_tokens, 1100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCommandCodeIncremental attributes project usage from the session header cwd", async () => {
  const { dir, filePath } = makeTree({
    lines: [headerLine("sess-project", "/home/user/project"), messageLine({ id: "m1" })],
  });
  const queuePath = path.join(dir, "queue.jsonl");
  const projectQueuePath = path.join(dir, "queue.project.jsonl");
  const cursors = {};

  try {
    const result = await parseCommandCodeIncremental({
      sessionFiles: [filePath],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(result.eventsAggregated, 1);
    assert.equal(commandCodeRows(queuePath).length, 1);
    // Project attribution requires a resolvable repository; a plain temp dir
    // yields no attributed rows but must never break the provider's buckets.
    assert.ok(result.projectBucketsQueued >= 0);

    // A header without cwd must not crash the parser either.
    const cwdless = path.join(path.dirname(filePath), "sess-nocwd.jsonl");
    fs.writeFileSync(
      cwdless,
      `${JSON.stringify({ type: "session", version: 3, id: "sess-nocwd" })}\n${messageLine({ id: "n1" })}\n`,
      "utf8",
    );
    const second = await parseCommandCodeIncremental({
      sessionFiles: [filePath, cwdless],
      cursors,
      queuePath,
      projectQueuePath,
    });
    assert.equal(second.eventsAggregated, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed fixture carries token counts and billed cost only", () => {
  const lines = fs.readFileSync(FIXTURE, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, "fixture has a header and at least one record");
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.type === "session") {
      assert.equal(record.cwd, "/home/user/project", "fixture cwd is anonymized");
      continue;
    }
    assert.equal(record.message, null, "fixture never carries a message body");
    assert.ok(!Object.prototype.hasOwnProperty.call(record, "content"), "fixture has no content field");
    assert.ok(record.usage && typeof record.usage === "object", "fixture record carries usage counters");
  }
});

test("parseCommandCodeIncremental is a no-op with no files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-empty-"));
  const result = await parseCommandCodeIncremental({
    sessionFiles: [],
    cursors: {},
    queuePath: path.join(dir, "queue.jsonl"),
  });
  assert.equal(result.recordsProcessed, 0);
  assert.equal(result.eventsAggregated, 0);
  assert.equal(result.bucketsQueued, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
