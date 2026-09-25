"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src") + path.sep;
const T0 = "2026-05-01T12:00:00.000Z";
const TOTALS = {
  input_tokens: 1000, cached_input_tokens: 0, cache_creation_input_tokens: 0,
  output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100,
  billable_total_tokens: 1100, total_cost_usd: 0.42, conversation_count: 1,
};
const ROW = { source: "command-code", model: "deepseek-v4.1-flash", hour_start: T0, ...TOTALS };
const PROJECT_KEY = "acme/synthetic-observation";
const PROJECT_ROW = {
  project_key: PROJECT_KEY, project_ref: `https://github.com/${PROJECT_KEY}`,
  source: "command-code", hour_start: T0, ...TOTALS,
};
const DOUBLE_TOTALS = {
  ...TOTALS, input_tokens: 2000, output_tokens: 200, total_tokens: 2200,
  billable_total_tokens: 2200, total_cost_usd: 0.84, conversation_count: 2,
};
const ZERO_TOTALS = Object.fromEntries(Object.keys(TOTALS).map((key) => [key, 0]));

function message(id) {
  return JSON.stringify({
    type: "message", id, timestamp: T0, model: "deepseek/deepseek-v4.1-flash", message: null,
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.42 },
  });
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

function readRows(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-observation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, "synthetic-project");
  const config = path.join(repo, ".git", "config");
  const file = path.join(home, ".commandcode", "projects", "fixture", "session.jsonl");
  write(config, `[remote "origin"]\n\turl = ${PROJECT_ROW.project_ref}.git\n`);
  write(file, `${JSON.stringify({ type: "session", version: 3, id: "session", cwd: repo })}\n${message("m1")}\n`);
  return { home, repo, config, file };
}

// Each test gets private CommonJS module instances and private built-in
// dependency facades. No global fs method, require cache or WSL cache is patched.
function scopedModules({ home, env = {}, redirect = (file) => file, ioFailure, runWsl } = {}) {
  const cache = new Map();
  const localEnv = {
    PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "C:\\Windows",
    HOME: home, USERPROFILE: home, TEMP: home, TMP: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    TOKENTRACKER_WSL_MODE: "native-only", TOKENTRACKER_NO_TELEMETRY: "1", DO_NOT_TRACK: "1",
    ...env,
  };
  const localProcess = Object.create(process);
  Object.defineProperties(localProcess, { env: { value: localEnv }, platform: { value: "win32" } });
  const localPromises = { ...fsp };
  for (const method of ["open", "stat", "readFile", "readdir"]) {
    localPromises[method] = async (file, ...args) => {
      const resolved = redirect(file);
      const error = ioFailure?.(method, resolved);
      if (error) throw error;
      return fsp[method](resolved, ...args);
    };
  }
  const localFs = { ...fs, promises: localPromises };
  for (const method of ["statSync", "existsSync"]) {
    localFs[method] = (file, ...args) => fs[method](redirect(file), ...args);
  }
  const childProcess = {
    ...require("node:child_process"),
    execFileSync(command, args, options) {
      assert.equal(command, "wsl.exe", "only synthetic WSL commands are expected");
      assert.equal(typeof runWsl, "function", "no real WSL invocation is allowed");
      return runWsl(args, options);
    },
  };
  const builtins = {
    fs: localFs, "fs/promises": localPromises,
    os: { ...os, homedir: () => home, tmpdir: () => home },
    child_process: childProcess, process: localProcess,
  };
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const localRequire = createRequire(filename);
    const module = { exports: {}, filename };
    cache.set(filename, module);
    function scopedRequire(specifier) {
      const builtin = specifier.replace(/^node:/, "");
      if (Object.hasOwn(builtins, builtin)) return builtins[builtin];
      const resolved = localRequire.resolve(specifier);
      return resolved.startsWith(SRC) && resolved.endsWith(".js") ? load(resolved) : localRequire(specifier);
    }
    scopedRequire.resolve = localRequire.resolve;
    let source = fs.readFileSync(filename, "utf8");
    if (filename === path.join(ROOT, "src", "lib", "rollout.js")) {
      source += "\nmodule.exports.projectObservationTest = { resolveGitConfigPath, readGitRemoteUrl, resolveProjectContextForPath };";
    }
    const evaluate = new Function("exports", "require", "module", "__filename", "__dirname", "process", source);
    evaluate(module.exports, scopedRequire, module, filename, path.dirname(filename), localProcess);
    return module.exports;
  }
  return { load: (file) => load(path.join(ROOT, file)), env: localEnv };
}

for (const operation of ["list", "whoami"]) {
  for (const code of ["ETIMEDOUT", "EIO", "EACCES", "EPERM"]) {
    test(`strict WSL ${operation} ${code} rejects and recovers from a default-provider negative cache`, (t) => {
      const { home } = fixture(t);
      const injected = Object.assign(new Error(`synthetic ${operation}`), { code });
      let fail = true;
      let calls = 0;
      const runtime = scopedModules({ home, runWsl(args) {
        const list = args[0] === "-l";
        if ((operation === "list") === list) {
          calls += 1;
          if (fail) throw injected;
        }
        return Buffer.from(list ? "  NAME STATE VERSION\n* Synthetic Running 2\n" : "fixture\n", list ? "utf16le" : "utf8");
      } });
      const wsl = runtime.load("src/lib/wsl-probe.js");
      const options = { existsSync: () => true, env: { TOKENTRACKER_WSL_MODE: "wsl-only" } };
      assert.equal(wsl.discoverWslHome(".commandcode", options), null, "default providers retain fail-safe behavior");
      assert.equal(wsl.discoverWslHome(".commandcode", options), null);
      assert.equal(calls, 1, "default negative-cache behavior is unchanged");
      assert.throws(() => wsl.discoverWslHome(".commandcode", { ...options, strict: true }), (error) => error === injected);
      fail = false;
      assert.equal(wsl.discoverWslHome(".commandcode", { ...options, strict: true }), "\\\\wsl$\\Synthetic\\home\\fixture\\.commandcode");
      assert.equal(calls, 3, "strict recovery retries, without resetting unrelated caches");
    });
  }
}

for (const missing of ["executable", "distros"]) {
  test(`strict WSL treats confirmed missing ${missing} as a normal empty result`, (t) => {
    const { home } = fixture(t);
    const runtime = scopedModules({ home, runWsl(args) {
      assert.equal(args[0], "-l");
      if (missing === "executable") throw Object.assign(new Error("synthetic missing wsl.exe"), { code: "ENOENT" });
      return Buffer.from("  NAME STATE VERSION\n", "utf16le");
    } });
    const wsl = runtime.load("src/lib/wsl-probe.js");
    assert.deepEqual(wsl.probeWslDistros({ strict: true }), []);
    assert.equal(wsl.discoverWslHome(".commandcode", { strict: true, env: { TOKENTRACKER_WSL_MODE: "wsl-only" } }), null);
  });
}

test("strict WSL never probes in native-only mode and does not accept an empty identity", (t) => {
  const { home } = fixture(t);
  let calls = 0;
  const runtime = scopedModules({ home, runWsl(args) {
    calls += 1;
    return Buffer.from(args[0] === "-l" ? "  NAME STATE VERSION\n* Synthetic Running 2\n" : "\n", args[0] === "-l" ? "utf16le" : "utf8");
  } });
  const wsl = runtime.load("src/lib/wsl-probe.js");
  assert.equal(wsl.discoverWslHome(".commandcode", { strict: true, env: { TOKENTRACKER_WSL_MODE: "native-only" } }), null);
  assert.equal(calls, 0);
  assert.throws(() => wsl.discoverWslHome(".commandcode", {
    strict: true, env: { TOKENTRACKER_WSL_MODE: "wsl-only" },
  }), { code: "EWSLIDENTITY" });
});

for (const [method, target, code, failAt] of [
  ["readFile", "config", "EIO", 1],
  ["stat", "config", "EACCES", 1],
  ["stat", "config", "EPERM", 2],
  ["stat", "git", "EIO", 1],
]) {
  test(`Command Code rejects project ${target} ${method} ${code} before queue/cursor publication`, async (t) => {
    const { home, config, file } = fixture(t);
    const injected = Object.assign(new Error("synthetic project observation failure"), { code });
    let fail = false;
    let calls = 0;
    const runtime = scopedModules({ home, ioFailure(operation, filename) {
      if (fail && operation === method && filename === (target === "git" ? path.dirname(config) : config)) {
        calls += 1;
        if (calls === failAt) return injected;
      }
      return null;
    } });
    const rollout = runtime.load("src/lib/rollout.js");
    const options = {
      sessionFiles: [file], cursors: {}, queuePath: path.join(home, "queue.jsonl"),
      projectQueuePath: path.join(home, "project.queue.jsonl"),
    };
    await rollout.parseCommandCodeIncremental(options);
    assert.deepEqual(readRows(options.queuePath), [ROW]);
    assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW]);
    const beforeCursor = JSON.stringify(options.cursors);
    const beforeHourly = fs.readFileSync(options.queuePath);
    const beforeProject = fs.readFileSync(options.projectQueuePath);
    const transcriptStat = fs.statSync(file);
    fail = true;
    await assert.rejects(rollout.parseCommandCodeIncremental(options), (error) => error === injected);
    assert.equal(JSON.stringify(options.cursors), beforeCursor);
    assert.deepEqual(fs.readFileSync(options.queuePath), beforeHourly);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), beforeProject);
    assert.equal(options.cursors.projectHourly.projects[PROJECT_KEY].purge_pending, false);
    assert.equal(fs.statSync(file).size, transcriptStat.size);
    assert.equal(fs.statSync(file).mtimeMs, transcriptStat.mtimeMs);
    fail = false;
    const recovered = await rollout.parseCommandCodeIncremental(options);
    assert.equal(recovered.recordsProcessed, 0);
    assert.equal(recovered.eventsAggregated, 0);
    assert.deepEqual(fs.readFileSync(options.queuePath), beforeHourly);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), beforeProject);
    assert.equal(options.cursors.commandCode.messages["command-code:session|m1"].projectKey, PROJECT_KEY);
  });
}

for (const removed of ["config", "remote"]) {
  test(`Command Code reconciles a successfully observed missing Git ${removed}`, async (t) => {
    const { home, config, file } = fixture(t);
    const rollout = scopedModules({ home }).load("src/lib/rollout.js");
    const options = {
      sessionFiles: [file], cursors: {}, queuePath: path.join(home, "queue.jsonl"),
      projectQueuePath: path.join(home, "project.queue.jsonl"),
    };
    await rollout.parseCommandCodeIncremental(options);
    if (removed === "config") fs.unlinkSync(config);
    else fs.writeFileSync(config, "[core]\n\trepositoryformatversion = 0\n");
    const change = await rollout.parseCommandCodeIncremental(options);
    assert.equal(change.recordsProcessed, 0);
    assert.equal(change.projectBucketsQueued, 1);
    assert.deepEqual(readRows(options.queuePath), [ROW]);
    assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW, { ...PROJECT_ROW, ...ZERO_TOTALS }]);
    const again = await rollout.parseCommandCodeIncremental(options);
    assert.equal(again.projectBucketsQueued, 0);
    assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW, { ...PROJECT_ROW, ...ZERO_TOTALS }]);
  });
}

test("Git helper strict I/O is opt-in and keeps default-provider fallback behavior", async (t) => {
  const { home, repo, config } = fixture(t);
  const injected = Object.assign(new Error("synthetic helper EIO"), { code: "EIO" });
  let method = "readFile";
  const runtime = scopedModules({ home, ioFailure(operation, file) {
    return operation === method && file === config ? injected : null;
  } });
  const helpers = runtime.load("src/lib/rollout.js").projectObservationTest;
  assert.equal(await helpers.readGitRemoteUrl(config), null);
  await assert.rejects(helpers.readGitRemoteUrl(config, { strictIo: true }), (error) => error === injected);
  method = "stat";
  assert.equal(await helpers.resolveGitConfigPath(repo), null);
  await assert.rejects(helpers.resolveGitConfigPath(repo, { strictIo: true }), (error) => error === injected);
});

test("Command Code aborts mixed new/old usage on project failure instead of inheriting an old public ref", async (t) => {
  const { home, config, file } = fixture(t);
  let fail = false;
  const injected = Object.assign(new Error("synthetic unverified project"), { code: "EIO" });
  const runtime = scopedModules({ home, ioFailure(method, filename) {
    return fail && method === "readFile" && filename === config ? injected : null;
  } });
  const rollout = runtime.load("src/lib/rollout.js");
  const options = {
    sessionFiles: [file], cursors: {}, queuePath: path.join(home, "queue.jsonl"),
    projectQueuePath: path.join(home, "project.queue.jsonl"),
  };
  await rollout.parseCommandCodeIncremental(options);
  const before = JSON.stringify(options.cursors);
  const hourly = fs.readFileSync(options.queuePath);
  const project = fs.readFileSync(options.projectQueuePath);
  fs.appendFileSync(file, message("m2") + "\n");
  fs.writeFileSync(config, '[remote "origin"]\n\turl = file:///synthetic-private-repository\n');
  fail = true;
  await assert.rejects(rollout.parseCommandCodeIncremental(options), (error) => error === injected);
  assert.equal(JSON.stringify(options.cursors), before);
  assert.deepEqual(fs.readFileSync(options.queuePath), hourly);
  assert.deepEqual(fs.readFileSync(options.projectQueuePath), project);
  fail = false;
  await rollout.parseCommandCodeIncremental(options);
  assert.deepEqual(readRows(options.queuePath), [ROW, { ...ROW, ...DOUBLE_TOTALS }]);
  assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW, { ...PROJECT_ROW, ...ZERO_TOTALS }]);
  assert.equal(options.cursors.commandCode.messages["command-code:session|m2"].projectKey, null);
  assert.notEqual(options.cursors.commandCode.messages["command-code:session|m2"].projectRef, PROJECT_ROW.project_ref);
});

for (const operation of ["list", "whoami"]) {
  test(`actual cmdSync preserves v2 queues/cursors through WSL ${operation} timeout and retries without cache reset`, async (t) => {
    const { home, repo } = fixture(t);
    const wslData = path.join(home, "synthetic-wsl", ".commandcode");
    const file = path.join(wslData, "projects", "fixture", "session.jsonl");
    write(file, `${JSON.stringify({ type: "session", version: 3, id: "session", cwd: repo })}\n${message("m1")}\n`);
    const aliases = [
      ["\\\\wsl$\\Synthetic\\home\\fixture\\.commandcode", wslData],
      ["\\\\wsl.localhost\\Synthetic\\home\\fixture\\.commandcode", wslData],
    ];
    // On POSIX test hosts, the real WSL mapper reanchors the synthetic cwd.
    // Redirect that project alias too, without changing production mapping.
    if (repo.startsWith("/")) {
      for (const root of ["\\\\wsl$\\Synthetic\\", "\\\\wsl.localhost\\Synthetic\\"]) {
        aliases.push([root + repo.slice(1).replaceAll("/", "\\"), repo]);
      }
    }
    const injected = Object.assign(new Error("synthetic WSL timeout"), { code: "ETIMEDOUT" });
    let fail = false;
    let injectedCalls = 0;
    const runtimeOptions = { home, env: { TOKENTRACKER_WSL_MODE: "wsl-only" },
      redirect(filename) {
        if (typeof filename !== "string") return filename;
        for (const [alias, target] of aliases) {
          if (filename === alias) return target;
          if (filename.startsWith(alias + path.sep)) return path.join(target, filename.slice(alias.length + 1));
        }
        if (filename.startsWith("\\\\wsl")) throw Object.assign(new Error("non-fixture WSL path"), { code: "ENOENT" });
        return filename;
      },
      runWsl(args) {
        const list = args[0] === "-l";
        if (fail && (operation === "list") === list) { injectedCalls += 1; throw injected; }
        return Buffer.from(list ? "  NAME STATE VERSION\n* Synthetic Running 2\n" : "fixture\n", list ? "utf16le" : "utf8");
      },
    };
    let runtime = scopedModules(runtimeOptions);
    const args = ["--auto", "--from-notify", "--source", "command-code", "--background", "--all-local-sources"];
    const sync = async () => {
      const diagnostics = {};
      await runtime.load("src/commands/sync.js").cmdSync(args, { diagnostics, cursorStoreOptions: { forceV2: true } });
      return diagnostics;
    };
    const tracker = path.join(home, ".tokentracker", "tracker");
    const queue = path.join(tracker, "queue.jsonl");
    const project = path.join(tracker, "project.queue.jsonl");
    const initial = await sync();
    assert.equal(initial.cursor_commits, 1);
    assert.deepEqual(readRows(queue), [ROW]);
    assert.deepEqual(readRows(project), [PROJECT_ROW]);
    const core = fs.readFileSync(initial.cursor_path);
    const hourly = fs.readFileSync(queue);
    const projectBytes = fs.readFileSync(project);
    // A fresh private module graph models process restart; recovery uses this
    // same graph, including negative caches populated by default providers.
    runtime = scopedModules(runtimeOptions);
    fail = true;
    const failed = await sync();
    assert.ok(injectedCalls > 0);
    assert.equal(failed.cursor_commits, 0);
    assert.deepEqual(fs.readFileSync(failed.cursor_path), core);
    assert.deepEqual(fs.readFileSync(queue), hourly);
    assert.deepEqual(fs.readFileSync(project), projectBytes);
    fail = false;
    fs.appendFileSync(file, message("m2") + "\n");
    const recovered = await sync();
    assert.equal(recovered.cursor_commits, 1);
    assert.deepEqual(readRows(queue), [ROW, { ...ROW, ...DOUBLE_TOTALS }]);
    assert.deepEqual(readRows(project), [PROJECT_ROW, { ...PROJECT_ROW, ...DOUBLE_TOTALS }]);
    const repeated = await sync();
    assert.equal(repeated.cursor_commits, 0);
    assert.deepEqual(readRows(queue), [ROW, { ...ROW, ...DOUBLE_TOTALS }]);
    assert.deepEqual(readRows(project), [PROJECT_ROW, { ...PROJECT_ROW, ...DOUBLE_TOTALS }]);
  });
}

for (const [method, target, code] of [
  ["readFile", "gitfile", "EACCES"],
  ["stat", "worktreeConfig", "EPERM"],
  ["readFile", "commondir", "EIO"],
  ["stat", "commonConfig", "EIO"],
  ["readFile", "commonConfig", "EPERM"],
]) {
  test(`strict project observation covers worktree ${target} ${method} ${code}`, async (t) => {
    const { home, file } = fixture(t);
    const worktree = path.join(home, "synthetic-worktree");
    const admin = path.join(home, "shared.git", "worktrees", "fixture");
    const files = {
      gitfile: path.join(worktree, ".git"),
      worktreeConfig: path.join(admin, "config"),
      commondir: path.join(admin, "commondir"),
      commonConfig: path.join(home, "shared.git", "config"),
    };
    write(files.gitfile, `gitdir: ${admin}\n`);
    write(files.commondir, "../..\n");
    write(files.commonConfig, `[remote "origin"]\n\turl = ${PROJECT_ROW.project_ref}.git\n`);
    write(file, `${JSON.stringify({ type: "session", version: 3, id: "session", cwd: worktree })}\n${message("m1")}\n`);
    const injected = Object.assign(new Error("synthetic worktree observation"), { code });
    let fail = false;
    const runtime = scopedModules({ home, ioFailure(operation, filename) {
      return fail && operation === method && filename === files[target] ? injected : null;
    } });
    const rollout = runtime.load("src/lib/rollout.js");
    const options = {
      sessionFiles: [file], cursors: {}, queuePath: path.join(home, "queue.jsonl"),
      projectQueuePath: path.join(home, "project.queue.jsonl"),
    };
    await rollout.parseCommandCodeIncremental(options);
    assert.deepEqual(readRows(options.queuePath), [ROW]);
    assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW]);
    const cursor = JSON.stringify(options.cursors);
    const hourly = fs.readFileSync(options.queuePath);
    const project = fs.readFileSync(options.projectQueuePath);
    fail = true;
    await assert.rejects(rollout.parseCommandCodeIncremental(options), (error) => error === injected);
    assert.equal(JSON.stringify(options.cursors), cursor);
    assert.deepEqual(fs.readFileSync(options.queuePath), hourly);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), project);
    fail = false;
    const recovered = await rollout.parseCommandCodeIncremental(options);
    assert.equal(recovered.recordsProcessed, 0);
    assert.equal(recovered.eventsAggregated, 0);
    assert.deepEqual(fs.readFileSync(options.queuePath), hourly);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), project);
  });
}

test("a later project's observation error prevents publishing an earlier file's new usage", async (t) => {
  const { home, file } = fixture(t);
  const secondRepo = path.join(home, "unverified-repository");
  const secondConfig = path.join(secondRepo, ".git", "config");
  const secondFile = path.join(path.dirname(file), "second.jsonl");
  write(secondConfig, '[remote "origin"]\n\turl = file:///synthetic-private-repository\n');
  write(secondFile, `${JSON.stringify({ type: "session", version: 3, id: "second", cwd: secondRepo })}\n${message("n1")}\n`);
  const injected = Object.assign(new Error("synthetic later metadata failure"), { code: "EIO" });
  let fail = false;
  const runtime = scopedModules({ home, ioFailure(method, filename) {
    return fail && method === "readFile" && filename === secondConfig ? injected : null;
  } });
  const rollout = runtime.load("src/lib/rollout.js");
  const options = {
    sessionFiles: [file], cursors: {}, queuePath: path.join(home, "queue.jsonl"),
    projectQueuePath: path.join(home, "project.queue.jsonl"),
  };
  await rollout.parseCommandCodeIncremental(options);
  const cursor = JSON.stringify(options.cursors);
  const hourly = fs.readFileSync(options.queuePath);
  const project = fs.readFileSync(options.projectQueuePath);
  fs.appendFileSync(file, message("m2") + "\n");
  options.sessionFiles.push(secondFile);
  fail = true;
  await assert.rejects(rollout.parseCommandCodeIncremental(options), (error) => error === injected);
  assert.equal(JSON.stringify(options.cursors), cursor);
  assert.deepEqual(fs.readFileSync(options.queuePath), hourly);
  assert.deepEqual(fs.readFileSync(options.projectQueuePath), project);
  fail = false;
  await rollout.parseCommandCodeIncremental(options);
  const total = {
    ...TOTALS, input_tokens: 3000, output_tokens: 300, total_tokens: 3300,
    billable_total_tokens: 3300, total_cost_usd: 1.26, conversation_count: 3,
  };
  assert.deepEqual(readRows(options.queuePath), [ROW, { ...ROW, ...total }]);
  assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW, { ...PROJECT_ROW, ...DOUBLE_TOTALS }]);
  assert.equal(options.cursors.commandCode.messages["command-code:second|n1"].projectKey, null);
});

test("actual cmdSync preserves v2 core and both queues on Git config EIO, without publishing purge intent", async (t) => {
  const { home, config } = fixture(t);
  const injected = Object.assign(new Error("synthetic Git config EIO"), { code: "EIO" });
  let fail = false;
  const runtime = scopedModules({ home, ioFailure(method, filename) {
    return fail && method === "readFile" && filename === config ? injected : null;
  } });
  const sync = async () => {
    const diagnostics = {};
    await runtime.load("src/commands/sync.js").cmdSync([
      "--auto", "--from-notify", "--source", "command-code", "--background", "--all-local-sources",
    ], { diagnostics, cursorStoreOptions: { forceV2: true } });
    return diagnostics;
  };
  const queue = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
  const project = path.join(home, ".tokentracker", "tracker", "project.queue.jsonl");
  const initial = await sync();
  assert.deepEqual(readRows(queue), [ROW]);
  assert.deepEqual(readRows(project), [PROJECT_ROW]);
  const core = fs.readFileSync(initial.cursor_path);
  const hourly = fs.readFileSync(queue);
  const projectBytes = fs.readFileSync(project);
  fail = true;
  const failed = await sync();
  assert.equal(failed.cursor_commits, 0);
  assert.deepEqual(fs.readFileSync(failed.cursor_path), core);
  assert.deepEqual(fs.readFileSync(queue), hourly);
  assert.deepEqual(fs.readFileSync(project), projectBytes);
  assert.equal(JSON.parse(core).projectHourly.projects[PROJECT_KEY].purge_pending, false);
  fail = false;
  const recovered = await sync();
  assert.equal(recovered.cursor_commits, 0);
  assert.deepEqual(fs.readFileSync(recovered.cursor_path), core);
  assert.deepEqual(fs.readFileSync(queue), hourly);
  assert.deepEqual(fs.readFileSync(project), projectBytes);
});
